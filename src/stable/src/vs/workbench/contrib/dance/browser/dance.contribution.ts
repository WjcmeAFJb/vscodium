/*---------------------------------------------------------------------------------------------
 *  Dance core contribution.
 *
 *  Embedded into VSCodium as a patch. Provides fast, in-renderer fallbacks for the
 *  hot paths that the bundled `extensions/dance` extension would otherwise reach via
 *  the extension-host RPC. The contribution also owns lifecycle-bound caches that
 *  guarantee state never accumulates beyond the lifetime of the editor or model it
 *  belongs to, which is what keeps the editor from "slowing down with time".
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ISelection, Selection } from '../../../../editor/common/core/selection.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, IWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

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
		const key = pattern + '' + flags;
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
// The contribution
// =================================================================================================

class DanceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dance';

	private readonly modeKey: IContextKey<string>;
	private readonly regexCache = new DanceRegexCache();
	private readonly states: DanceEditorStates;

	constructor(
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IModelService private readonly modelService: IModelService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.modeKey = DANCE_MODE_KEY.bindTo(contextKeyService);
		this.states = this._register(new DanceEditorStates(codeEditorService));

		this.registerCommands();
	}

	// ------------------------------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------------------------------

	private registerCommands(): void {

		const findEditorByUri = (accessor: ServicesAccessor, uriStr?: string): ICodeEditor | null => {
			const ces = accessor.get(ICodeEditorService);
			if (uriStr) {
				const target = URI.parse(uriStr).toString();
				for (const e of ces.listCodeEditors()) {
					const m = e.getModel();
					if (m && m.uri.toString() === target) { return e; }
				}
			}
			return ces.getFocusedCodeEditor() ?? ces.getActiveCodeEditor();
		};

		// _dance.setMode — synchronously update the dance mode context key.
		// Avoids the round-trip through the extension host's `setContext` command.
		this._register(CommandsRegistry.registerCommand({
			id: '_dance.setMode',
			handler: (_accessor, mode: string) => {
				if (typeof mode !== 'string') { return false; }
				this.modeKey.set(mode);
				return true;
			},
		}));

		// _dance.atomicEdit — apply a list of edits and final selections in one transaction.
		// Replaces a chain of vscode.workspace.applyEdit + editor.selections = ... that would
		// otherwise require multiple ext-host -> renderer round trips.
		this._register(CommandsRegistry.registerCommand({
			id: '_dance.atomicEdit',
			handler: (accessor, payload: { uri?: string; edits: Array<{ range: IRange; text: string }>; selections?: ISelection[] }) => {
				if (!payload || !Array.isArray(payload.edits)) { return false; }
				const editor = findEditorByUri(accessor, payload.uri);
				if (!editor) { return false; }
				const model = editor.getModel();
				if (!model) { return false; }
				editor.pushUndoStop();
				const ok = editor.executeEdits('dance', payload.edits.map(e => ({
					range: e.range,
					text: e.text,
					forceMoveMarkers: true,
				})));
				if (payload.selections && payload.selections.length > 0) {
					editor.setSelections(payload.selections.map(s => Selection.liftSelection(s)));
				}
				editor.pushUndoStop();
				return ok;
			},
		}));

		// _dance.regex.exec — cached regex execution against a model.
		// Compiling a regex per command is one of the most common paper cuts; the WeakMap cache
		// erases that cost on subsequent uses without ever leaking once the model is disposed.
		this._register(CommandsRegistry.registerCommand({
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
				try { re = this.regexCache.get(model, payload.pattern, flags); } catch { return []; }
				const text = model.getValue();
				const max = Math.max(1, Math.min(payload.max ?? 1024, 16384));
				const start = Math.max(0, Math.min(payload.fromOffset ?? 0, text.length));
				re.lastIndex = start;
				const out: Array<{ index: number; length: number }> = [];
				let m: RegExpExecArray | null;
				while (out.length < max && (m = re.exec(text)) !== null) {
					out.push({ index: m.index, length: m[0].length });
					if (m[0].length === 0) { re.lastIndex++; } // avoid zero-length infinite loop
				}
				return out;
			},
		}));

		// _dance.pushSelections — push a snapshot onto the per-editor selection ring (bounded).
		this._register(CommandsRegistry.registerCommand({
			id: '_dance.pushSelections',
			handler: (accessor, payload: { uri?: string; selections: ISelection[] }) => {
				const editor = findEditorByUri(accessor, payload?.uri);
				if (!editor || !payload || !Array.isArray(payload.selections)) { return false; }
				const st = this.states.getOrCreate(editor);
				if (st.selectionRing.length < SELECTION_RING_CAP) {
					st.selectionRing.push(payload.selections);
					st.ringIdx = st.selectionRing.length - 1;
				} else {
					st.ringIdx = (st.ringIdx + 1) % SELECTION_RING_CAP;
					st.selectionRing[st.ringIdx] = payload.selections;
				}
				return true;
			},
		}));

		// _dance.popSelections — restore a snapshot.
		this._register(CommandsRegistry.registerCommand({
			id: '_dance.popSelections',
			handler: (accessor, payload?: { uri?: string }) => {
				const editor = findEditorByUri(accessor, payload?.uri);
				if (!editor) { return false; }
				const st = this.states.getOrCreate(editor);
				const sels = st.selectionRing[st.ringIdx];
				if (!sels) { return false; }
				editor.setSelections(sels.map(s => Selection.liftSelection(s)));
				if (st.selectionRing.length > 0) {
					st.ringIdx = (st.ringIdx - 1 + st.selectionRing.length) % st.selectionRing.length;
				}
				return true;
			},
		}));

		// _dance.diag — diagnostic command; returns counts so the user can confirm the patch is alive.
		this._register(CommandsRegistry.registerCommand({
			id: '_dance.diag',
			handler: () => {
				return {
					version: 1,
					editorsTracked: this.states.size,
					modelsOpen: this.modelService.getModels().length,
					mode: this.modeKey.get(),
				};
			},
		}));

		this.logService.info('[dance] core contribution registered');
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
// Registration
// =================================================================================================

registerWorkbenchContribution2(DanceContribution.ID, DanceContribution, WorkbenchPhase.AfterRestored);

export { DanceContribution };
