/*---------------------------------------------------------------------------------------------
 *  vscode API shim for in-renderer dance loading.
 *
 *  The `dance` extension was written against the public `vscode` API. We embed its
 *  bundle directly into the workbench (see danceLoader.ts) so it runs in the
 *  renderer's own JS thread — no extension host, no postMessage, no websocket.
 *  For dance's `import * as vscode from "vscode"` calls to resolve, we hand the
 *  evaluated bundle this object as the synthetic `vscode` module.
 *
 *  Every accessor below is a thin wrapper around a workbench-internal service.
 *  Calls become regular synchronous-or-promise function invocations on the
 *  active workbench services; there is no marshalling boundary anywhere.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Position as InternalPosition } from '../../../../editor/common/core/position.js';
import { Range as InternalRange, IRange } from '../../../../editor/common/core/range.js';
import { Selection as InternalSelection, ISelection } from '../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBulkEditService, ResourceTextEdit, ResourceEdit } from '../../../../editor/browser/services/bulkEditService.js';

// =================================================================================================
// Value types (vscode public API equivalents)
// =================================================================================================

/** vscode.Position public API. Backed by editor/common/core/position internals. */
class VscodePosition {
	constructor(public readonly line: number, public readonly character: number) { }
	isBefore(other: VscodePosition): boolean { return this.line < other.line || (this.line === other.line && this.character < other.character); }
	isBeforeOrEqual(other: VscodePosition): boolean { return this.isBefore(other) || this.isEqual(other); }
	isAfter(other: VscodePosition): boolean { return !this.isBeforeOrEqual(other); }
	isAfterOrEqual(other: VscodePosition): boolean { return !this.isBefore(other); }
	isEqual(other: VscodePosition): boolean { return this.line === other.line && this.character === other.character; }
	compareTo(other: VscodePosition): number {
		if (this.line < other.line) { return -1; }
		if (this.line > other.line) { return 1; }
		return this.character - other.character;
	}
	translate(linesOrChange?: number | { lineDelta?: number; characterDelta?: number }, characters?: number): VscodePosition {
		if (typeof linesOrChange === 'object' && linesOrChange !== null) {
			return new VscodePosition(this.line + (linesOrChange.lineDelta ?? 0), this.character + (linesOrChange.characterDelta ?? 0));
		}
		const dl = typeof linesOrChange === 'number' ? linesOrChange : 0;
		return new VscodePosition(this.line + dl, this.character + (characters ?? 0));
	}
	with(lineOrChange?: number | { line?: number; character?: number }, character?: number): VscodePosition {
		if (typeof lineOrChange === 'object' && lineOrChange !== null) {
			return new VscodePosition(lineOrChange.line ?? this.line, lineOrChange.character ?? this.character);
		}
		const ln = typeof lineOrChange === 'number' ? lineOrChange : this.line;
		return new VscodePosition(ln, character ?? this.character);
	}
	toJSON(): { line: number; character: number } { return { line: this.line, character: this.character }; }
}

class VscodeRange {
	public readonly start: VscodePosition;
	public readonly end: VscodePosition;
	constructor(startOrA: VscodePosition | number, endOrB: VscodePosition | number, c?: number, d?: number) {
		if (typeof startOrA === 'number') {
			this.start = new VscodePosition(startOrA, endOrB as number);
			this.end = new VscodePosition(c!, d!);
		} else {
			this.start = startOrA;
			this.end = endOrB as VscodePosition;
		}
		// Normalise: start must come before end.
		if (this.start.compareTo(this.end) > 0) {
			[this.start, this.end] = [this.end, this.start];
		}
	}
	get isEmpty(): boolean { return this.start.isEqual(this.end); }
	get isSingleLine(): boolean { return this.start.line === this.end.line; }
	contains(positionOrRange: VscodePosition | VscodeRange): boolean {
		if (positionOrRange instanceof VscodeRange) {
			return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
		}
		return positionOrRange.isAfterOrEqual(this.start) && positionOrRange.isBeforeOrEqual(this.end);
	}
	isEqual(other: VscodeRange): boolean { return this.start.isEqual(other.start) && this.end.isEqual(other.end); }
	intersection(other: VscodeRange): VscodeRange | undefined {
		const s = this.start.compareTo(other.start) >= 0 ? this.start : other.start;
		const e = this.end.compareTo(other.end) <= 0 ? this.end : other.end;
		if (s.compareTo(e) > 0) { return undefined; }
		return new VscodeRange(s, e);
	}
	union(other: VscodeRange): VscodeRange {
		const s = this.start.compareTo(other.start) <= 0 ? this.start : other.start;
		const e = this.end.compareTo(other.end) >= 0 ? this.end : other.end;
		return new VscodeRange(s, e);
	}
	with(startOrChange?: VscodePosition | { start?: VscodePosition; end?: VscodePosition }, end?: VscodePosition): VscodeRange {
		if (startOrChange && !(startOrChange instanceof VscodePosition)) {
			return new VscodeRange(startOrChange.start ?? this.start, startOrChange.end ?? this.end);
		}
		return new VscodeRange((startOrChange as VscodePosition) ?? this.start, end ?? this.end);
	}
}

class VscodeSelection extends VscodeRange {
	public readonly anchor: VscodePosition;
	public readonly active: VscodePosition;
	constructor(anchorOrA: VscodePosition | number, activeOrB: VscodePosition | number, c?: number, d?: number) {
		const anchor = typeof anchorOrA === 'number' ? new VscodePosition(anchorOrA, activeOrB as number) : anchorOrA;
		const active = typeof anchorOrA === 'number' ? new VscodePosition(c!, d!) : (activeOrB as VscodePosition);
		const start = anchor.isBeforeOrEqual(active) ? anchor : active;
		const end = anchor.isBeforeOrEqual(active) ? active : anchor;
		super(start, end);
		this.anchor = anchor;
		this.active = active;
	}
	get isReversed(): boolean { return !this.anchor.isBeforeOrEqual(this.active); }
}

function toInternalPosition(p: VscodePosition): InternalPosition { return new InternalPosition(p.line + 1, p.character + 1); }
function fromInternalPosition(p: InternalPosition): VscodePosition { return new VscodePosition(p.lineNumber - 1, p.column - 1); }
function toInternalRange(r: VscodeRange): InternalRange { return new InternalRange(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1); }
function fromInternalRange(r: IRange): VscodeRange { return new VscodeRange(r.startLineNumber - 1, r.startColumn - 1, r.endLineNumber - 1, r.endColumn - 1); }
function toInternalSelection(s: VscodeSelection): InternalSelection {
	return new InternalSelection(s.anchor.line + 1, s.anchor.character + 1, s.active.line + 1, s.active.character + 1);
}
function fromInternalSelection(s: ISelection): VscodeSelection {
	const anchor = new VscodePosition(s.selectionStartLineNumber - 1, s.selectionStartColumn - 1);
	const active = new VscodePosition(s.positionLineNumber - 1, s.positionColumn - 1);
	return new VscodeSelection(anchor, active);
}

// =================================================================================================
// Enums (re-export the public-API shapes inline)
// =================================================================================================

/* eslint-disable @typescript-eslint/no-namespace */
const VscodeEnums = {
	EndOfLine: { LF: 1, CRLF: 2 },
	TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
	TextEditorCursorStyle: { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 },
	TextEditorLineNumbersStyle: { Off: 0, On: 1, Relative: 2, Interval: 3 },
	ConfigurationTarget: { Global: ConfigurationTarget.USER, Workspace: ConfigurationTarget.WORKSPACE, WorkspaceFolder: ConfigurationTarget.WORKSPACE_FOLDER },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
	DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
	TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
	ExtensionKind: { UI: 1, Workspace: 2 },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	UIKind: { Desktop: 1, Web: 2 },
};

// =================================================================================================
// Disposable + EventEmitter shims
// =================================================================================================

class VscodeDisposable {
	private _fn?: () => void;
	constructor(fn: () => void) { this._fn = fn; }
	dispose(): void { try { this._fn?.(); } finally { this._fn = undefined; } }
	static from(...disposables: { dispose(): unknown }[]): VscodeDisposable {
		return new VscodeDisposable(() => { for (const d of disposables) { d.dispose(); } });
	}
}

class VscodeEventEmitter<T> {
	private readonly _e = new Emitter<T>();
	get event(): (l: (e: T) => unknown, thisArg?: unknown) => VscodeDisposable {
		return (l, thisArg) => {
			const sub = this._e.event(l, thisArg);
			return new VscodeDisposable(() => sub.dispose());
		};
	}
	fire(value: T): void { this._e.fire(value); }
	dispose(): void { this._e.dispose(); }
}

// =================================================================================================
// TextDocument / TextEditor adapters around ITextModel and ICodeEditor
// =================================================================================================

const documentByModel = new WeakMap<ITextModel, VscodeTextDocument>();

class VscodeTextDocument {
	constructor(public readonly model: ITextModel) { }
	get uri(): URI { return this.model.uri; }
	get fileName(): string { return this.model.uri.fsPath; }
	get isUntitled(): boolean { return this.model.uri.scheme === 'untitled'; }
	get languageId(): string { return this.model.getLanguageId(); }
	get version(): number { return this.model.getVersionId(); }
	get isDirty(): boolean { return false; /* would need ITextFileService */ }
	get isClosed(): boolean { return this.model.isDisposed(); }
	get eol(): number { return this.model.getEOL() === '\n' ? 1 : 2; }
	get lineCount(): number { return this.model.getLineCount(); }
	get encoding(): string { return 'utf8'; }
	save(): Promise<boolean> { return Promise.resolve(true); }
	lineAt(lineOrPosition: number | VscodePosition): { lineNumber: number; text: string; range: VscodeRange; rangeIncludingLineBreak: VscodeRange; firstNonWhitespaceCharacterIndex: number; isEmptyOrWhitespace: boolean } {
		const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
		const text = this.model.getLineContent(lineNumber + 1);
		return {
			lineNumber,
			text,
			range: new VscodeRange(lineNumber, 0, lineNumber, text.length),
			rangeIncludingLineBreak: new VscodeRange(lineNumber, 0, lineNumber + 1, 0),
			firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
			isEmptyOrWhitespace: text.trim().length === 0,
		};
	}
	offsetAt(p: VscodePosition): number { return this.model.getOffsetAt(toInternalPosition(p)); }
	positionAt(offset: number): VscodePosition { return fromInternalPosition(this.model.getPositionAt(offset)); }
	getText(range?: VscodeRange): string { return range ? this.model.getValueInRange(toInternalRange(range)) : this.model.getValue(); }
	getWordRangeAtPosition(p: VscodePosition, _re?: RegExp): VscodeRange | undefined {
		const w = this.model.getWordAtPosition(toInternalPosition(p));
		if (!w) { return undefined; }
		return new VscodeRange(p.line, w.startColumn - 1, p.line, w.endColumn - 1);
	}
	validatePosition(p: VscodePosition): VscodePosition { return fromInternalPosition(this.model.validatePosition(toInternalPosition(p))); }
	validateRange(r: VscodeRange): VscodeRange { return fromInternalRange(this.model.validateRange(toInternalRange(r))); }
}

function getDocument(model: ITextModel): VscodeTextDocument {
	let d = documentByModel.get(model);
	if (!d) { d = new VscodeTextDocument(model); documentByModel.set(model, d); }
	return d;
}

class VscodeTextEditorEdit {
	private readonly _ops: { range: IRange; text: string | null; forceMoveMarkers: boolean }[] = [];
	replace(location: VscodeRange | VscodePosition | VscodeSelection, value: string): void {
		const range = location instanceof VscodePosition ? new VscodeRange(location, location) : location;
		this._ops.push({ range: toInternalRange(range), text: value, forceMoveMarkers: false });
	}
	insert(location: VscodePosition, value: string): void {
		this._ops.push({ range: toInternalRange(new VscodeRange(location, location)), text: value, forceMoveMarkers: true });
	}
	delete(location: VscodeRange | VscodeSelection): void {
		this._ops.push({ range: toInternalRange(location), text: '', forceMoveMarkers: false });
	}
	setEndOfLine(_eol: number): void { /* not supported by direct executeEdits, ignore */ }
	get operations(): { range: IRange; text: string | null; forceMoveMarkers: boolean }[] { return this._ops; }
}

const editorById = new Map<string, VscodeTextEditor>();

class VscodeTextEditor {
	public selections: VscodeSelection[];
	constructor(public readonly editor: ICodeEditor) {
		this.selections = (editor.getSelections() ?? []).map(fromInternalSelection);
	}
	get document(): VscodeTextDocument { return getDocument(this.editor.getModel()!); }
	get selection(): VscodeSelection { return this.selections[0]; }
	set selection(value: VscodeSelection) { this.selections = [value]; this._sync(); }
	get visibleRanges(): VscodeRange[] {
		return (this.editor.getVisibleRanges() ?? []).map(fromInternalRange);
	}
	get options(): { tabSize: number; insertSpaces: boolean; cursorStyle: number; lineNumbers: number } {
		const model = this.editor.getModel();
		const opts = model?.getOptions();
		const rawTabSize = opts?.tabSize;
		return {
			tabSize: typeof rawTabSize === 'number' ? rawTabSize : 4,
			insertSpaces: opts?.insertSpaces ?? true,
			cursorStyle: (this.editor.getOption(/* CursorStyle option index */ 24) as unknown as number | undefined) ?? 1,
			lineNumbers: 1,
		};
	}
	get viewColumn(): number | undefined { return undefined; }
	private _sync(): void {
		this.editor.setSelections(this.selections.map(toInternalSelection));
	}
	edit(callback: (builder: VscodeTextEditorEdit) => void, _options?: { undoStopBefore?: boolean; undoStopAfter?: boolean }): Promise<boolean> {
		const builder = new VscodeTextEditorEdit();
		try { callback(builder); } catch (err) { return Promise.reject(err); }
		const ops = builder.operations.filter(o => o.text !== null);
		if (ops.length === 0) { return Promise.resolve(true); }
		this.editor.pushUndoStop();
		const ok = this.editor.executeEdits('dance', ops.map(op => ({ ...op, text: op.text ?? '' })));
		this.editor.pushUndoStop();
		// Re-read the editor's selections after the edit.
		this.selections = (this.editor.getSelections() ?? []).map(fromInternalSelection);
		return Promise.resolve(ok);
	}
	revealRange(range: VscodeRange, _revealType?: number): void {
		this.editor.revealRange(toInternalRange(range));
	}
	setDecorations(_decorationType: { key: string }, _ranges: VscodeRange[]): void { /* TODO: decorations */ }
	hide(): void { /* no-op */ }
	show(): void { /* no-op */ }
}

function getOrMakeEditor(editor: ICodeEditor | null): VscodeTextEditor | undefined {
	if (!editor) { return undefined; }
	const id = editor.getId();
	let e = editorById.get(id);
	if (!e) {
		e = new VscodeTextEditor(editor);
		editorById.set(id, e);
		editor.onDidDispose(() => editorById.delete(id));
		editor.onDidChangeCursorSelection(() => {
			e!.selections = (editor.getSelections() ?? []).map(fromInternalSelection);
		});
	} else {
		e.selections = (editor.getSelections() ?? []).map(fromInternalSelection);
	}
	return e;
}

// =================================================================================================
// The vscode namespace (what `import * as vscode from "vscode"` gets)
// =================================================================================================

export interface IVscodeShim { [k: string]: any; }

export function createVscodeShim(accessor: ServicesAccessor, ctxDisposables: DisposableStore): IVscodeShim {
	const codeEditorService = accessor.get(ICodeEditorService);
	const modelService = accessor.get(IModelService);
	const commandService = accessor.get(ICommandService);
	const configService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);
	const dialogService = accessor.get(IDialogService);
	const quickInputService = accessor.get(IQuickInputService);
	const contextKeyService = accessor.get(IContextKeyService);
	const keybindingService = accessor.get(IKeybindingService);
	const logService = accessor.get(ILogService);
	const bulkEditService = accessor.get(IBulkEditService);

	// --- Events that dance subscribes to ---
	const onDidChangeActiveTextEditor = new VscodeEventEmitter<VscodeTextEditor | undefined>();
	const onDidChangeTextEditorSelection = new VscodeEventEmitter<{ textEditor: VscodeTextEditor; selections: VscodeSelection[]; kind: number | undefined }>();
	const onDidChangeTextEditorVisibleRanges = new VscodeEventEmitter<{ textEditor: VscodeTextEditor; visibleRanges: VscodeRange[] }>();
	const onDidChangeVisibleTextEditors = new VscodeEventEmitter<VscodeTextEditor[]>();
	const onDidChangeConfiguration = new VscodeEventEmitter<{ affectsConfiguration: (s: string) => boolean }>();
	const onDidOpenTextDocument = new VscodeEventEmitter<VscodeTextDocument>();
	const onDidCloseTextDocument = new VscodeEventEmitter<VscodeTextDocument>();
	const onDidChangeTextDocument = new VscodeEventEmitter<{ document: VscodeTextDocument; contentChanges: any[] }>();

	ctxDisposables.add(toDisposable(() => {
		onDidChangeActiveTextEditor.dispose();
		onDidChangeTextEditorSelection.dispose();
		onDidChangeTextEditorVisibleRanges.dispose();
		onDidChangeVisibleTextEditors.dispose();
		onDidChangeConfiguration.dispose();
		onDidOpenTextDocument.dispose();
		onDidCloseTextDocument.dispose();
		onDidChangeTextDocument.dispose();
	}));

	const hookEditor = (e: ICodeEditor) => {
		const v = getOrMakeEditor(e);
		ctxDisposables.add(e.onDidChangeCursorSelection(() => {
			if (v) {
				onDidChangeTextEditorSelection.fire({ textEditor: v, selections: v.selections, kind: undefined });
			}
		}));
		ctxDisposables.add(e.onDidScrollChange(() => {
			if (v) {
				onDidChangeTextEditorVisibleRanges.fire({ textEditor: v, visibleRanges: v.visibleRanges });
			}
		}));
		ctxDisposables.add(e.onDidFocusEditorWidget(() => { onDidChangeActiveTextEditor.fire(v); }));
		return v;
	};
	// Hook editors already present at construction time.
	for (const e of codeEditorService.listCodeEditors()) { hookEditor(e); }
	ctxDisposables.add(codeEditorService.onCodeEditorAdd(e => {
		const v = hookEditor(e);
		const focused = codeEditorService.getFocusedCodeEditor();
		if (focused === e) { onDidChangeActiveTextEditor.fire(v); }
		onDidChangeVisibleTextEditors.fire(codeEditorService.listCodeEditors().map(c => getOrMakeEditor(c)!).filter(Boolean));
	}));
	ctxDisposables.add(codeEditorService.onCodeEditorRemove(_e => {
		onDidChangeVisibleTextEditors.fire(codeEditorService.listCodeEditors().map(c => getOrMakeEditor(c)!).filter(Boolean));
	}));
	ctxDisposables.add(modelService.onModelAdded(m => onDidOpenTextDocument.fire(getDocument(m))));
	ctxDisposables.add(modelService.onModelRemoved(m => onDidCloseTextDocument.fire(getDocument(m))));
	ctxDisposables.add(configService.onDidChangeConfiguration(e => onDidChangeConfiguration.fire({
		affectsConfiguration: (s: string) => e.affectsConfiguration(s),
	})));

	// --- The shape ---
	const vscodeShim: any = {
		// Value types
		Position: VscodePosition,
		Range: VscodeRange,
		Selection: VscodeSelection,
		Uri: URI,
		Disposable: VscodeDisposable,
		EventEmitter: VscodeEventEmitter,

		// Enums
		EndOfLine: VscodeEnums.EndOfLine,
		TextEditorRevealType: VscodeEnums.TextEditorRevealType,
		TextEditorCursorStyle: VscodeEnums.TextEditorCursorStyle,
		TextEditorLineNumbersStyle: VscodeEnums.TextEditorLineNumbersStyle,
		ConfigurationTarget: VscodeEnums.ConfigurationTarget,
		StatusBarAlignment: VscodeEnums.StatusBarAlignment,
		ViewColumn: VscodeEnums.ViewColumn,
		OverviewRulerLane: VscodeEnums.OverviewRulerLane,
		DecorationRangeBehavior: VscodeEnums.DecorationRangeBehavior,
		TextEditorSelectionChangeKind: VscodeEnums.TextEditorSelectionChangeKind,
		ExtensionKind: VscodeEnums.ExtensionKind,
		TreeItemCollapsibleState: VscodeEnums.TreeItemCollapsibleState,
		ExtensionMode: VscodeEnums.ExtensionMode,
		UIKind: VscodeEnums.UIKind,

		// ThemeColor / ThemeIcon — placeholder objects
		ThemeColor: class { constructor(public id: string) { } },
		ThemeIcon: class { constructor(public id: string, public color?: any) { } },

		// CancellationToken / CancellationTokenSource
		CancellationTokenSource: class {
			private readonly _e = new Emitter<void>();
			public readonly token = {
				isCancellationRequested: false as boolean,
				onCancellationRequested: this._e.event,
			};
			cancel() { (this.token as any).isCancellationRequested = true; this._e.fire(); }
			dispose() { this._e.dispose(); }
		},

		// window
		window: {
			get activeTextEditor() { return getOrMakeEditor(codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor()); },
			get visibleTextEditors() { return codeEditorService.listCodeEditors().map(c => getOrMakeEditor(c)!).filter(Boolean); },
			get state() { return { focused: true }; },
			onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
			onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditors.event,
			onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,
			onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRanges.event,
			onDidChangeTextEditorOptions: new VscodeEventEmitter<unknown>().event,
			onDidChangeWindowState: new VscodeEventEmitter<unknown>().event,
			showInformationMessage(message: string, ...items: any[]) { notificationService.info(message); return Promise.resolve(items[0]); },
			showWarningMessage(message: string, ...items: any[]) { notificationService.warn(message); return Promise.resolve(items[0]); },
			showErrorMessage(message: string, ...items: any[]) { notificationService.error(message); return Promise.resolve(items[0]); },
			async showInputBox(options?: { prompt?: string; placeHolder?: string; value?: string; validateInput?: (v: string) => string | null | undefined }): Promise<string | undefined> {
				return quickInputService.input({ prompt: options?.prompt, placeHolder: options?.placeHolder, value: options?.value, validateInput: options?.validateInput as any });
			},
			async showQuickPick(items: any, options?: any): Promise<any> {
				const arr = await Promise.resolve(items);
				const list = (Array.isArray(arr) ? arr : []).map((it: any) => typeof it === 'string' ? { label: it } : it);
				return quickInputService.pick(list, { placeHolder: options?.placeHolder, canPickMany: options?.canPickMany });
			},
			createInputBox() {
				// The internal IInputBox already implements the same public surface dance uses
				// (.value, .placeholder, .password, .validationMessage, .onDidChangeValue,
				// .onDidAccept, .show(), .hide(), .dispose()). Hand it back unchanged.
				return quickInputService.createInputBox();
			},
			createQuickPick() {
				// IQuickPick exposes .items, .value, .placeholder, .onDidChangeValue, .onDidAccept,
				// .activeItems, .selectedItems, .show(), .hide(), .dispose() — directly usable.
				return quickInputService.createQuickPick();
			},
			async showTextDocument(documentOrUri: any, _columnOrOptions?: any, _preserveFocus?: boolean) {
				// Resolve to a URI then route to the workbench's editor.open command. We can't
				// directly return a VscodeTextEditor here without IEditorService, but dance only
				// uses the result for its `.viewColumn`/`.document.uri` properties on the file-pick
				// flow — both come back implicitly via the now-focused editor.
				const uri = documentOrUri instanceof URI ? documentOrUri
					: (documentOrUri && documentOrUri.uri instanceof URI) ? documentOrUri.uri
					: typeof documentOrUri === 'string' ? URI.parse(documentOrUri)
					: URI.from(documentOrUri);
				await commandService.executeCommand('vscode.open', uri);
				return getOrMakeEditor(codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor());
			},
			createStatusBarItem(_alignment?: number, _priority?: number) {
				return {
					text: '',
					tooltip: '',
					command: undefined as any,
					alignment: _alignment,
					priority: _priority,
					show() { /* TODO via IStatusbarService */ },
					hide() { /* TODO */ },
					dispose() { },
				};
			},
			createOutputChannel(name: string) {
				const channel = {
					name,
					append: (msg: string) => logService.info(`[${name}] ${msg}`),
					appendLine: (msg: string) => logService.info(`[${name}] ${msg}`),
					replace: (msg: string) => logService.info(`[${name}] ${msg}`),
					clear: () => { },
					show: () => { },
					hide: () => { },
					dispose: () => { },
				};
				return channel;
			},
			createTextEditorDecorationType(_options: any) {
				const key = `dance-decoration-${Math.random().toString(36).slice(2)}`;
				return { key, dispose() { } };
			},
			createTreeView(_id: string, _options: any) {
				return {
					visible: false,
					selection: [],
					onDidChangeSelection: new VscodeEventEmitter<unknown>().event,
					onDidExpandElement: new VscodeEventEmitter<unknown>().event,
					onDidCollapseElement: new VscodeEventEmitter<unknown>().event,
					onDidChangeVisibility: new VscodeEventEmitter<unknown>().event,
					reveal: () => Promise.resolve(),
					dispose: () => { },
				};
			},
			registerTreeDataProvider() { return new VscodeDisposable(() => { }); },
			registerWebviewPanelSerializer() { return new VscodeDisposable(() => { }); },
			registerCustomEditorProvider() { return new VscodeDisposable(() => { }); },
		},

		// commands
		commands: {
			registerCommand(id: string, handler: (...args: any[]) => any, _thisArg?: any): VscodeDisposable {
				const sub = CommandsRegistry.registerCommand(id, (_acc, ...args: any[]) => handler(...args));
				return new VscodeDisposable(() => sub.dispose());
			},
			registerTextEditorCommand(id: string, handler: (editor: VscodeTextEditor, edit: VscodeTextEditorEdit, ...args: any[]) => any, _thisArg?: any): VscodeDisposable {
				const sub = CommandsRegistry.registerCommand(id, (_acc, ...args: any[]) => {
					const editor = getOrMakeEditor(codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor());
					if (!editor) { return; }
					const builder = new VscodeTextEditorEdit();
					try { handler(editor, builder, ...args); } catch (e) { logService.error(e as Error); }
					const ops = builder.operations.filter(o => o.text !== null);
					if (ops.length > 0) {
						editor.editor.pushUndoStop();
						editor.editor.executeEdits('dance', ops.map(op => ({ ...op, text: op.text ?? '' })));
						editor.editor.pushUndoStop();
					}
				});
				return new VscodeDisposable(() => sub.dispose());
			},
			executeCommand<T>(id: string, ...args: any[]): Promise<T> {
				return commandService.executeCommand<T>(id, ...args);
			},
			getCommands(_filterInternal?: boolean): Promise<string[]> {
				return Promise.resolve(Object.keys(CommandsRegistry.getCommands()));
			},
		},

		// workspace
		workspace: {
			get name() { return undefined; },
			get workspaceFolders() { return undefined; },
			get textDocuments() { return modelService.getModels().map(m => getDocument(m)); },
			get notebookDocuments() { return []; },
			get isTrusted() { return true; },
			fs: {
				stat: () => Promise.reject(new Error('workspace.fs not supported in renderer-mode dance')),
				readFile: () => Promise.reject(new Error('workspace.fs not supported')),
				writeFile: () => Promise.reject(new Error('workspace.fs not supported')),
			},
			onDidChangeWorkspaceFolders: new VscodeEventEmitter<unknown>().event,
			onDidChangeConfiguration: onDidChangeConfiguration.event,
			onDidOpenTextDocument: onDidOpenTextDocument.event,
			onDidCloseTextDocument: onDidCloseTextDocument.event,
			onDidChangeTextDocument: onDidChangeTextDocument.event,
			onDidSaveTextDocument: new VscodeEventEmitter<unknown>().event,
			onWillSaveTextDocument: new VscodeEventEmitter<unknown>().event,
			getConfiguration(section?: string, _scope?: any) {
				const root = configService.getValue<any>(section ?? '') ?? {};
				return {
					get<T>(key: string, defaultValue?: T): T | undefined {
						const value = configService.getValue<T>(section ? `${section}.${key}` : key);
						return value !== undefined ? value : defaultValue;
					},
					has(key: string): boolean {
						return configService.getValue(section ? `${section}.${key}` : key) !== undefined;
					},
					inspect<T>(key: string) {
						const full = section ? `${section}.${key}` : key;
						const v = configService.inspect<T>(full);
						return {
							key: full,
							defaultValue: v?.defaultValue,
							globalValue: v?.userValue,
							workspaceValue: v?.workspaceValue,
							workspaceFolderValue: v?.workspaceFolderValue,
						};
					},
					update(key: string, value: any, target?: number) {
						const t = target ?? ConfigurationTarget.WORKSPACE;
						return configService.updateValue(section ? `${section}.${key}` : key, value, t);
					},
					...root,
				};
			},
			applyEdit(edit: any): Promise<boolean> {
				const operations: ResourceEdit[] = [];
				for (const [uri, edits] of (edit?._edits ?? edit?.entries?.() ?? [])) {
					for (const e of edits) {
						operations.push(new ResourceTextEdit(uri, { range: toInternalRange(e.range), text: e.newText ?? '' }, undefined, undefined));
					}
				}
				return bulkEditService.apply(operations).then(r => !!r.isApplied);
			},
			openTextDocument(target: any) {
				const uri = target instanceof URI ? target : (typeof target === 'string' ? URI.parse(target) : URI.from(target));
				const m = modelService.getModel(uri);
				return Promise.resolve(m ? getDocument(m) : undefined);
			},
			saveAll() { return Promise.resolve(true); },
			asRelativePath(p: string | URI) { return typeof p === 'string' ? p : p.fsPath; },
			registerTextDocumentContentProvider() { return new VscodeDisposable(() => { }); },
			registerTaskProvider() { return new VscodeDisposable(() => { }); },
			registerFileSystemProvider() { return new VscodeDisposable(() => { }); },
		},

		// languages
		languages: {
			getLanguages() { return Promise.resolve([]); },
			match() { return 0; },
			registerCodeLensProvider() { return new VscodeDisposable(() => { }); },
			registerCompletionItemProvider() { return new VscodeDisposable(() => { }); },
			registerDocumentFormattingEditProvider() { return new VscodeDisposable(() => { }); },
			registerDocumentRangeFormattingEditProvider() { return new VscodeDisposable(() => { }); },
			registerHoverProvider() { return new VscodeDisposable(() => { }); },
			registerDefinitionProvider() { return new VscodeDisposable(() => { }); },
			registerReferenceProvider() { return new VscodeDisposable(() => { }); },
			registerOnTypeFormattingEditProvider() { return new VscodeDisposable(() => { }); },
			setLanguageConfiguration() { return new VscodeDisposable(() => { }); },
			createDiagnosticCollection(_name?: string) {
				return {
					name: _name ?? 'dance',
					set: () => { },
					delete: () => { },
					clear: () => { },
					forEach: () => { },
					get: () => undefined,
					has: () => false,
					dispose: () => { },
				};
			},
			onDidChangeDiagnostics: new VscodeEventEmitter<unknown>().event,
		},

		// extensions (dance reads its own manifest via this)
		extensions: {
			all: [] as any[],
			getExtension(id: string) {
				if (id === 'gregoire.dance') {
					return {
						id,
						isActive: true,
						extensionPath: '/dance',
						packageJSON: (vscodeShim as any).__danceManifest ?? {},
						exports: undefined as any,
						activate() { return Promise.resolve(); },
					};
				}
				return undefined;
			},
			onDidChange: new VscodeEventEmitter<unknown>().event,
		},

		// env
		env: {
			appName: 'VSCodium',
			appHost: 'web',
			appRoot: '/',
			machineId: 'dance-renderer',
			sessionId: 'dance-session',
			language: 'en',
			uriScheme: 'vscode',
			remoteName: undefined as string | undefined,
			uiKind: 2, // UIKind.Web
			clipboard: {
				readText: () => navigator.clipboard?.readText?.() ?? Promise.resolve(''),
				writeText: (t: string) => navigator.clipboard?.writeText?.(t) ?? Promise.resolve(),
			},
			openExternal: (uri: any) => { try { window.open(typeof uri === 'string' ? uri : uri?.toString?.(), '_blank'); return Promise.resolve(true); } catch { return Promise.resolve(false); } },
			asExternalUri: (uri: any) => Promise.resolve(uri),
		},

		// Constants
		version: '1.119.0',

		// Adapter helpers (consumed by the loader; not part of the public API)
		__internalConvert: { fromInternalSelection, toInternalSelection, fromInternalRange, toInternalRange, getDocument, getOrMakeEditor },
	};

	return vscodeShim;
}
