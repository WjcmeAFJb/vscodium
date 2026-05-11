/*---------------------------------------------------------------------------------------------
 *  Dance core contribution.
 *
 *  Embedded into VSCodium as a patch. Provides fast, in-renderer fallbacks for the
 *  hot paths that the bundled `extensions/dance` extension would otherwise reach via
 *  the extension-host RPC. The contribution also owns lifecycle-bound caches that
 *  guarantee state never accumulates beyond the lifetime of the editor or model it
 *  belongs to, which is what keeps the editor from "slowing down with time".
 *
 *  Command handlers register at MODULE LOAD time so the fast paths exist before any
 *  extension (built-in or otherwise) has a chance to probe for them. Per-editor and
 *  per-model state is kept in the workbench-instantiated `DanceContribution` and
 *  reached from the handlers via a module-level singleton.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ISelection, Selection } from '../../../../editor/common/core/selection.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, IWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { DanceMainThreadLoader } from './danceLoader.js';
import { createVscodeShim } from './vscodeShim.js';

// =================================================================================================
// Context keys
// =================================================================================================

/** Per-window mode context key. Mirrors `dance.mode` from the extension but is updated synchronously. */
const DANCE_MODE_KEY = new RawContextKey<string>('dance.mode', 'normal');

// =================================================================================================
// Per-model regex cache (auto-evicted with the model itself via WeakMap)
// =================================================================================================

interface IModelRegexEntry { readonly regex: RegExp; lastUsed: number; }

/**
 * Cache of compiled `RegExp`s scoped to a `ITextModel`. Backed by a `WeakMap` so that
 * when the underlying model is disposed, its cache disappears alongside it; we never
 * have to remember to clean up. A small per-model LRU cap keeps a runaway buffer
 * (e.g. one that accumulates many ad-hoc patterns) from holding on to memory forever.
 */
class DanceRegexCache {
	private static readonly PER_MODEL_LIMIT = 64;
	private readonly cache = new WeakMap<ITextModel, Map<string, IModelRegexEntry>>();

	get(model: ITextModel, pattern: string, flags: string): RegExp {
		const key = pattern + '\x00' + flags;
		let perModel = this.cache.get(model);
		if (!perModel) {
			perModel = new Map();
			this.cache.set(model, perModel);
		}
		const existing = perModel.get(key);
		if (existing) {
			existing.lastUsed = Date.now();
			existing.regex.lastIndex = 0;
			return existing.regex;
		}
		const regex = new RegExp(pattern, flags);
		if (perModel.size >= DanceRegexCache.PER_MODEL_LIMIT) {
			let oldestKey: string | undefined; let oldest = Number.POSITIVE_INFINITY;
			for (const [k, v] of perModel) { if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; } }
			if (oldestKey !== undefined) { perModel.delete(oldestKey); }
		}
		perModel.set(key, { regex, lastUsed: Date.now() });
		return regex;
	}
}

// =================================================================================================
// Per-editor scratch state (auto-disposed when the editor goes away)
// =================================================================================================

interface IDanceEditorState {
	mode: string;
	count: number;
	register: string | undefined;
	selectionRing: ISelection[][]; // bounded ring buffer; never grows beyond cap
	ringIdx: number;
	readonly disposables: DisposableStore;
}

const SELECTION_RING_CAP = 32;

/**
 * Manages per-`ICodeEditor` Dance state. The state is keyed off the editor's
 * weak identity (`editor.getId()`). When the editor is removed (via
 * `ICodeEditorService.onCodeEditorRemove`) we proactively dispose its state so
 * we never accumulate dead entries.
 */
class DanceEditorStates extends Disposable {
	private readonly states = new Map<string, IDanceEditorState>();

	constructor(codeEditorService: ICodeEditorService) {
		super();
		this._register(codeEditorService.onCodeEditorRemove(e => this.removeFor(e)));
	}

	getOrCreate(editor: ICodeEditor): IDanceEditorState {
		const id = editor.getId();
		let s = this.states.get(id);
		if (!s) {
			const disposables = new DisposableStore();
			s = {
				mode: 'normal',
				count: 0,
				register: undefined,
				selectionRing: [],
				ringIdx: 0,
				disposables,
			};
			this.states.set(id, s);
			disposables.add(editor.onDidDispose(() => this.removeFor(editor)));
		}
		return s;
	}

	removeFor(editor: ICodeEditor): void {
		const id = editor.getId();
		const s = this.states.get(id);
		if (s) {
			s.disposables.dispose();
			this.states.delete(id);
		}
	}

	override dispose(): void {
		for (const s of this.states.values()) { s.disposables.dispose(); }
		this.states.clear();
		super.dispose();
	}

	get size() { return this.states.size; }
}

// =================================================================================================
// Module-level singletons (so command handlers can run before the contribution instantiates)
// =================================================================================================

const moduleRegexCache = new DanceRegexCache();

/** Lazily-installed slots populated when the workbench contribution is constructed. */
interface IDanceRuntime {
	readonly modeKey: IContextKey<string>;
	readonly states: DanceEditorStates;
}

let runtime: IDanceRuntime | undefined;

function findEditorByUri(accessor: ServicesAccessor, uriStr?: string): ICodeEditor | null {
	const ces = accessor.get(ICodeEditorService);
	if (uriStr) {
		const target = URI.parse(uriStr).toString();
		for (const e of ces.listCodeEditors()) {
			const m = e.getModel();
			if (m && m.uri.toString() === target) { return e; }
		}
	}
	return ces.getFocusedCodeEditor() ?? ces.getActiveCodeEditor();
}

// -------------------------------------------------------------------------------------------------
// Compat adapters
//
// Extension code that reaches us via `vscode.commands.executeCommand` may pass selections /
// ranges in either of two shapes:
//
//   • the public-API form used inside the extension host:
//       Selection { anchor: {line, character}, active: {line, character} }
//       Range     { start: {line, character}, end: {line, character} }
//     (zero-based positions)
//
//   • the internal form used by the renderer directly:
//       ISelection { selectionStartLineNumber, selectionStartColumn, positionLineNumber, positionColumn }
//       IRange     { startLineNumber, startColumn, endLineNumber, endColumn }
//     (one-based positions)
//
// We accept either by sniffing fields, so a vanilla dance bundle works without modification.
// -------------------------------------------------------------------------------------------------

function asISelection(s: any): ISelection | null {
	if (!s || typeof s !== 'object') { return null; }
	if (typeof s.selectionStartLineNumber === 'number'
		&& typeof s.selectionStartColumn === 'number'
		&& typeof s.positionLineNumber === 'number'
		&& typeof s.positionColumn === 'number') {
		return s as ISelection;
	}
	if (s.anchor && s.active
		&& typeof s.anchor.line === 'number' && typeof s.anchor.character === 'number'
		&& typeof s.active.line === 'number' && typeof s.active.character === 'number') {
		return {
			selectionStartLineNumber: s.anchor.line + 1,
			selectionStartColumn: s.anchor.character + 1,
			positionLineNumber: s.active.line + 1,
			positionColumn: s.active.character + 1,
		};
	}
	return null;
}

function asIRange(r: any): IRange | null {
	if (!r || typeof r !== 'object') { return null; }
	if (typeof r.startLineNumber === 'number'
		&& typeof r.startColumn === 'number'
		&& typeof r.endLineNumber === 'number'
		&& typeof r.endColumn === 'number') {
		return r as IRange;
	}
	if (r.start && r.end
		&& typeof r.start.line === 'number' && typeof r.start.character === 'number'
		&& typeof r.end.line === 'number' && typeof r.end.character === 'number') {
		return {
			startLineNumber: r.start.line + 1,
			startColumn: r.start.character + 1,
			endLineNumber: r.end.line + 1,
			endColumn: r.end.character + 1,
		};
	}
	return null;
}

// =================================================================================================
// Commands — registered eagerly at module load
// =================================================================================================

CommandsRegistry.registerCommand({
	id: '_dance.setMode',
	handler: (accessor, mode: string) => {
		if (typeof mode !== 'string') { return false; }
		if (runtime) {
			runtime.modeKey.set(mode);
		} else {
			// The workbench hasn't instantiated us yet — write through the regular service.
			accessor.get(IContextKeyService).createKey('dance.mode', mode);
		}
		return true;
	},
});

CommandsRegistry.registerCommand({
	id: '_dance.atomicEdit',
	handler: (accessor, payload: { uri?: string; edits: Array<{ range: any; text: string }>; selections?: any[] }) => {
		if (!payload || !Array.isArray(payload.edits)) { return false; }
		const editor = findEditorByUri(accessor, payload.uri);
		if (!editor) { return false; }
		const model = editor.getModel();
		if (!model) { return false; }
		const normalisedEdits: Array<{ range: IRange; text: string; forceMoveMarkers: boolean }> = [];
		for (const e of payload.edits) {
			const r = asIRange(e?.range);
			if (!r || typeof e.text !== 'string') { return false; }
			normalisedEdits.push({ range: r, text: e.text, forceMoveMarkers: true });
		}
		const normalisedSels: Selection[] = [];
		if (Array.isArray(payload.selections)) {
			for (const s of payload.selections) {
				const ns = asISelection(s);
				if (ns) { normalisedSels.push(Selection.liftSelection(ns)); }
			}
		}
		editor.pushUndoStop();
		const ok = editor.executeEdits('dance', normalisedEdits);
		if (normalisedSels.length > 0) {
			editor.setSelections(normalisedSels);
		}
		editor.pushUndoStop();
		return ok;
	},
});

// _dance.rotateContents — rotate the contents of a list of non-overlapping selections in one
// renderer-side transaction. Avoids dance scheduling N round-trips of editor.edit / setSelections,
// which is the path that "TextEditor edit failed" floods on a slow client.
CommandsRegistry.registerCommand({
	id: '_dance.rotateContents',
	handler: (accessor, payload: { uri?: string; selections: any[]; by: number }) => {
		if (!payload || !Array.isArray(payload.selections) || typeof payload.by !== 'number') {
			return null;
		}
		const editor = findEditorByUri(accessor, payload.uri);
		if (!editor) { return null; }
		const model = editor.getModel();
		if (!model) { return null; }

		// Normalise + remember the caller's order so we can emit results in the same order.
		const liftedOrig: Selection[] = [];
		for (const s of payload.selections) {
			const ns = asISelection(s);
			if (!ns) { return null; }
			liftedOrig.push(Selection.liftSelection(ns));
		}
		const n = liftedOrig.length;
		if (n === 0) { return []; }
		const by = ((payload.by % n) + n) % n;
		if (by === 0) {
			return liftedOrig.map(s => s.toJSON());
		}

		// Index by ascending start position for the edit transaction (non-overlapping ⇒ unique sort).
		const order = liftedOrig.map((_, i) => i)
			.sort((a, b) => Range.compareRangesUsingStarts(liftedOrig[a], liftedOrig[b]));

		// Snapshot text BEFORE we issue any edit so the rotation source isn't shifted by the edits.
		const sortedRanges = order.map(i => liftedOrig[i]);
		const sortedTexts = sortedRanges.map(r => model.getValueInRange(r));
		const newTextsSorted = sortedTexts.map((_, i) => sortedTexts[(i - by + n) % n]);

		const edits: Array<{ range: IRange; text: string; forceMoveMarkers: boolean }> = [];
		for (let i = 0; i < n; i++) {
			edits.push({ range: sortedRanges[i], text: newTextsSorted[i], forceMoveMarkers: true });
		}

		// Compute where each replacement lands in post-edit coordinates by accumulating the net
		// offset shift in ascending order.
		let cumulativeShift = 0;
		const newSortedSelections: Selection[] = sortedRanges.map((r, i) => {
			const startOffset = model.getOffsetAt({ lineNumber: r.startLineNumber, column: r.startColumn }) + cumulativeShift;
			const oldLen = model.getOffsetAt({ lineNumber: r.endLineNumber, column: r.endColumn })
				- model.getOffsetAt({ lineNumber: r.startLineNumber, column: r.startColumn });
			const newLen = newTextsSorted[i].length;
			cumulativeShift += newLen - oldLen;
			// We don't know the post-edit positions yet; we'll resolve to (line, col) below using
			// the freshly-edited model.
			return { _start: startOffset, _end: startOffset + newLen } as unknown as Selection;
		});

		editor.pushUndoStop();
		const ok = editor.executeEdits('dance.rotateContents', edits);
		editor.pushUndoStop();
		if (!ok) { return null; }

		// Now resolve offsets to (line, col) against the post-edit model.
		const resolvedSorted = newSortedSelections.map((tmp: any) => {
			const start = model.getPositionAt(tmp._start);
			const end = model.getPositionAt(tmp._end);
			return new Selection(start.lineNumber, start.column, end.lineNumber, end.column);
		});

		// Re-emit in the caller's original order.
		const out = new Array<Selection>(n);
		for (let i = 0; i < n; i++) {
			out[order[i]] = resolvedSorted[i];
		}
		editor.setSelections(out);
		return out.map(s => s.toJSON());
	},
});

CommandsRegistry.registerCommand({
	id: '_dance.regex.exec',
	handler: (accessor, payload: { uri: string; pattern: string; flags?: string; fromOffset?: number; max?: number }) => {
		if (!payload || typeof payload.pattern !== 'string' || typeof payload.uri !== 'string') {
			return [];
		}
		const ms = accessor.get(IModelService);
		const uri = URI.parse(payload.uri);
		const model = ms.getModel(uri);
		if (!model) { return []; }
		const requestedFlags = payload.flags ?? 'g';
		const flags = requestedFlags.includes('g') ? requestedFlags : (requestedFlags + 'g');
		let re: RegExp;
		try { re = moduleRegexCache.get(model, payload.pattern, flags); } catch { return []; }
		const text = model.getValue();
		const max = Math.max(1, Math.min(payload.max ?? 1024, 16384));
		const start = Math.max(0, Math.min(payload.fromOffset ?? 0, text.length));
		re.lastIndex = start;
		const out: Array<{ index: number; length: number }> = [];
		let m: RegExpExecArray | null;
		while (out.length < max && (m = re.exec(text)) !== null) {
			out.push({ index: m.index, length: m[0].length });
			if (m[0].length === 0) { re.lastIndex++; }
		}
		return out;
	},
});

CommandsRegistry.registerCommand({
	id: '_dance.pushSelections',
	handler: (accessor, payload: { uri?: string; selections: any[] }) => {
		if (!runtime) { return false; }
		const editor = findEditorByUri(accessor, payload?.uri);
		if (!editor || !payload || !Array.isArray(payload.selections)) { return false; }
		const normalised: ISelection[] = [];
		for (const s of payload.selections) {
			const ns = asISelection(s);
			if (ns) { normalised.push(ns); }
		}
		if (normalised.length === 0) { return false; }
		const st = runtime.states.getOrCreate(editor);
		if (st.selectionRing.length < SELECTION_RING_CAP) {
			st.selectionRing.push(normalised);
			st.ringIdx = st.selectionRing.length - 1;
		} else {
			st.ringIdx = (st.ringIdx + 1) % SELECTION_RING_CAP;
			st.selectionRing[st.ringIdx] = normalised;
		}
		return true;
	},
});

CommandsRegistry.registerCommand({
	id: '_dance.popSelections',
	handler: (accessor, payload?: { uri?: string }) => {
		if (!runtime) { return false; }
		const editor = findEditorByUri(accessor, payload?.uri);
		if (!editor) { return false; }
		const st = runtime.states.getOrCreate(editor);
		const sels = st.selectionRing[st.ringIdx];
		if (!sels) { return false; }
		editor.setSelections(sels.map(s => Selection.liftSelection(s)));
		if (st.selectionRing.length > 0) {
			st.ringIdx = (st.ringIdx - 1 + st.selectionRing.length) % st.selectionRing.length;
		}
		return true;
	},
});

CommandsRegistry.registerCommand({
	id: '_dance.diag',
	handler: (accessor) => {
		const ms = accessor.get(IModelService);
		return {
			version: 1,
			runtimeReady: !!runtime,
			editorsTracked: runtime?.states.size ?? 0,
			modelsOpen: ms.getModels().length,
			mode: runtime?.modeKey.get(),
		};
	},
});

// =================================================================================================
// Workbench contribution — installs the per-editor state runtime and the bound mode context key
// =================================================================================================

class DanceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dance';

	constructor(
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		// eslint-disable-next-line no-console
		console.info('[dance] DanceContribution constructor running …');
		const states = this._register(new DanceEditorStates(codeEditorService));
		const modeKey = DANCE_MODE_KEY.bindTo(contextKeyService);
		runtime = { modeKey, states };
		this.logService.info('[dance] core contribution online');

		// Expose runCommand on the debug global so headless tests can drive dance
		// directly through the workbench's command service.
		(globalThis as any).__danceDebug.runCommand = (id: string, ...args: any[]) => commandService.executeCommand(id, ...args);

		// Load dance directly into the workbench's main thread.  This is the
		// "no IPC" path: dance.activate() runs as a regular function call here,
		// and every vscode.* call hits a workbench service synchronously.
		//
		// IMPORTANT: the ServicesAccessor handed back by invokeFunction is only
		// valid synchronously inside the callback (see InstantiationService.invokeFunction).
		// We therefore have to build the shim — which resolves every workbench service it
		// needs — inside the callback, and hand the resolved shim to the loader.
		const shimDisposables = new DisposableStore();
		this._register(shimDisposables);
		const shim = instantiationService.invokeFunction(accessor =>
			createVscodeShim(accessor, shimDisposables));
		const loader = new DanceMainThreadLoader(shim, shimDisposables, this.logService);
		this._register(loader);
		void loader.activate();
	}

	override dispose(): void {
		runtime = undefined;
		super.dispose();
	}
}

// =================================================================================================
// Configuration (allows users to opt out of fast paths if they ever misbehave)
// =================================================================================================

Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration).registerConfiguration({
	id: 'dance.core',
	order: 100,
	type: 'object',
	title: 'Dance (core)',
	properties: {
		'dance.core.fastPaths': {
			type: 'boolean',
			default: true,
			description: 'Use the renderer-side fast paths for edits/selections/regex. Disable only for debugging.',
		},
	},
});

// =================================================================================================
// Registration — earliest workbench phase that has services available
// =================================================================================================

// eslint-disable-next-line no-console
console.info('[dance] contribution module loaded; registering with workbench…');

// Expose a tiny diagnostic on the global so headless tests can interrogate the
// state of dance command registration from outside the workbench.
(globalThis as any).__danceDebug = {
	listCommands: () => Object.keys(CommandsRegistry.getCommands()),
	hasCommand: (id: string) => !!CommandsRegistry.getCommand(id),
	commandCount: () => Object.keys(CommandsRegistry.getCommands()).length,
	danceCommandCount: () => Object.keys(CommandsRegistry.getCommands()).filter(k => k.startsWith('dance.') || k.startsWith('_dance.')).length,
	runtime: () => runtime,
	manifest: () => ({ activated: !!runtime, modeKey: runtime?.modeKey.get() }),
};

registerWorkbenchContribution2(DanceContribution.ID, DanceContribution, WorkbenchPhase.BlockRestore);

export { DanceContribution };
