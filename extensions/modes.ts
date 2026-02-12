import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CustomEditor, ModelSelectorComponent, SettingsManager } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// =============================================================================
// Types and constants
// =============================================================================

type ModeName = string;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	/** Optional border color override: simple names (red/blue/...) or legacy theme token. */
	color?: string;
};

type ModesFile = {
	version: 1;
	currentMode: ModeName;
	modes: Record<ModeName, ModeSpec>;
};

type LoadedModes = {
	data: ModesFile;
	/** True when file explicitly contains: "modes": {} */
	explicitlyEmptyModes: boolean;
};

const CUSTOM_MODE_NAME = "custom" as const;

const BOOTSTRAP_MODES: Array<{ name: ModeName; spec: Required<Pick<ModeSpec, "provider" | "modelId" | "thinkingLevel">> }> = [
	{ name: "rush", spec: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" } },
	{ name: "smart", spec: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "low" } },
	{ name: "deep", spec: { provider: "openai-codex", modelId: "gpt-5.3-codex", thinkingLevel: "high" } },
];

const MODE_UI_CONFIGURE = "Configure modes…";
const MODE_UI_ADD = "Add mode…";
const MODE_UI_BACK = "Back";

const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_UNSET_LABEL = "(don't change)";

const COLOR_UNSET_LABEL = "match thinking color";
const SIMPLE_MODE_COLORS = ["red", "yellow", "green", "cyan", "blue", "purple", "gray", "white"] as const;
type SimpleModeColor = (typeof SIMPLE_MODE_COLORS)[number];

const SIMPLE_MODE_COLOR_ANSI: Record<SimpleModeColor, string> = {
	red: "\u001b[31m",
	yellow: "\u001b[33m",
	green: "\u001b[32m",
	cyan: "\u001b[36m",
	blue: "\u001b[34m",
	purple: "\u001b[35m",
	gray: "\u001b[90m",
	white: "\u001b[37m",
};

// =============================================================================
// File/path helpers
// =============================================================================

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getGlobalAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUserPath(env);
	return path.join(os.homedir(), ".pi", "agent");
}

function getGlobalModesPath(): string {
	return path.join(getGlobalAgentDir(), "modes.json");
}

function getProjectModesPath(cwd: string): string {
	return path.join(cwd, ".pi", "modes.json");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function getMtimeMs(p: string): Promise<number | null> {
	try {
		const st = await fs.stat(p);
		return st.mtimeMs;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPathForFile(filePath: string): string {
	return `${filePath}.lock`;
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = getLockPathForFile(filePath);
	await ensureDirForFile(lockPath);

	const start = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
					"utf8",
				);
			} catch {
				// ignore
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			try {
				const st = await fs.stat(lockPath);
				if (Date.now() - st.mtimeMs > 30_000) {
					await fs.unlink(lockPath);
					continue;
				}
			} catch {
				// ignore
			}

			if (Date.now() - start > 5_000) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}

			await sleep(40 + Math.random() * 80);
		}
	}
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await ensureDirForFile(filePath);

	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);
	await fs.writeFile(tmpPath, content, "utf8");

	try {
		await fs.rename(tmpPath, filePath);
	} catch (err: any) {
		if (err?.code === "EEXIST" || err?.code === "EPERM") {
			await fs.unlink(filePath).catch(() => {});
			await fs.rename(tmpPath, filePath);
		} else {
			await fs.unlink(tmpPath).catch(() => {});
			throw err;
		}
	}
}

// =============================================================================
// Modes file helpers
// =============================================================================

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level as ThinkingLevel;
	return ALL_THINKING_LEVELS.includes(v) ? v : undefined;
}

function sanitizeModeSpec(spec: unknown): ModeSpec {
	const obj = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	return {
		provider: typeof obj.provider === "string" ? obj.provider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
		thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
		color: typeof obj.color === "string" ? obj.color : undefined,
	};
}

function createBootstrapModesFile(): ModesFile {
	const modes: Record<ModeName, ModeSpec> = {};
	for (const mode of BOOTSTRAP_MODES) {
		modes[mode.name] = { ...mode.spec };
	}

	return {
		version: 1,
		currentMode: "smart",
		modes,
	};
}

function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
	return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

function ensureCurrentModeValid(file: ModesFile): void {
	const names = orderedModeNames(file.modes);
	if (names.length === 0) {
		file.currentMode = "";
		return;
	}
	if (!file.currentMode || !(file.currentMode in file.modes) || file.currentMode === CUSTOM_MODE_NAME) {
		file.currentMode = names.includes("smart") ? "smart" : names[0]!;
	}
}

async function loadModesFile(filePath: string): Promise<LoadedModes> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		const hasModesProp = Object.prototype.hasOwnProperty.call(parsed, "modes");
		const parsedModesRaw = parsed.modes;
		const modesRaw =
			typeof parsedModesRaw === "object" && parsedModesRaw !== null
				? (parsedModesRaw as Record<string, unknown>)
				: undefined;

		if (hasModesProp && modesRaw && Object.keys(modesRaw).length === 0) {
			return {
				data: {
					version: 1,
					currentMode: "",
					modes: {},
				},
				explicitlyEmptyModes: true,
			};
		}

		const modes: Record<string, ModeSpec> = {};
		for (const [k, v] of Object.entries(modesRaw ?? {})) {
			modes[k] = sanitizeModeSpec(v);
		}

		const currentMode = typeof parsed.currentMode === "string" ? parsed.currentMode : "";
		const file: ModesFile = {
			version: 1,
			currentMode,
			modes,
		};

		if (orderedModeNames(file.modes).length === 0) {
			return {
				data: createBootstrapModesFile(),
				explicitlyEmptyModes: false,
			};
		}

		ensureCurrentModeValid(file);
		return { data: file, explicitlyEmptyModes: false };
	} catch {
		return {
			data: createBootstrapModesFile(),
			explicitlyEmptyModes: false,
		};
	}
}

async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
	ensureCurrentModeValid(data);
	await atomicWriteUtf8(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function resolveModesPath(cwd: string): Promise<string> {
	const projectPath = getProjectModesPath(cwd);
	if (await fileExists(projectPath)) return projectPath;
	return getGlobalModesPath();
}

function cloneModesFile(file: ModesFile): ModesFile {
	return JSON.parse(JSON.stringify(file)) as ModesFile;
}

// =============================================================================
// Runtime state
// =============================================================================

type ModeRuntime = {
	filePath: string;
	fileMtimeMs: number | null;
	data: ModesFile;
	explicitlyEmptyModes: boolean;
	overlayEnabled: boolean;
	lastRealMode: string;
	currentMode: string;
	applying: boolean;
};

const runtime: ModeRuntime = {
	filePath: "",
	fileMtimeMs: null,
	data: createBootstrapModesFile(),
	explicitlyEmptyModes: false,
	overlayEnabled: true,
	lastRealMode: "smart",
	currentMode: "smart",
	applying: false,
};

// Updated by setEditor() when custom editor is instantiated.
let requestEditorRender: (() => void) | undefined;

// Overlay state for non-matching selection.
let customOverlay: ModeSpec | null = null;

// We track model select events to avoid stale ctx.model snapshots.
let lastObservedModel: { provider?: string; modelId?: string } = {};

// Serializes cycle shortcut repeats so rapid key repeats can't race mode inference.
let modeCycleQueue: Promise<void> = Promise.resolve();

async function ensureRuntime(_pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const filePath = await resolveModesPath(ctx.cwd);
	const mtimeMs = await getMtimeMs(filePath);

	const filePathChanged = runtime.filePath !== filePath;
	const fileChanged = filePathChanged || runtime.fileMtimeMs !== mtimeMs;
	if (fileChanged) {
		runtime.filePath = filePath;
		runtime.fileMtimeMs = mtimeMs;

		const loaded = await loadModesFile(filePath);
		runtime.data = loaded.data;
		runtime.explicitlyEmptyModes = loaded.explicitlyEmptyModes;
		runtime.overlayEnabled = !loaded.explicitlyEmptyModes && orderedModeNames(loaded.data.modes).length > 0;

		if (!runtime.overlayEnabled) {
			runtime.currentMode = CUSTOM_MODE_NAME;
			runtime.lastRealMode = "";
			customOverlay = null;
		} else {
			ensureCurrentModeValid(runtime.data);
			if (!runtime.currentMode || !(runtime.currentMode in runtime.data.modes) || runtime.currentMode === CUSTOM_MODE_NAME) {
				runtime.currentMode = runtime.data.currentMode;
			}
			if (!runtime.lastRealMode || !(runtime.lastRealMode in runtime.data.modes)) {
				runtime.lastRealMode = runtime.currentMode;
			}
		}
	}
}

async function mutateModesFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mutator: (data: ModesFile) => void,
): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.filePath) return;

	await withFileLock(runtime.filePath, async () => {
		const loaded = await loadModesFile(runtime.filePath);
		const next = cloneModesFile(loaded.data);
		mutator(next);

		const names = orderedModeNames(next.modes);
		if (names.length === 0) {
			next.currentMode = "";
		}

		await saveModesFile(runtime.filePath, next);
	});

	// Force refresh on next ensureRuntime call.
	runtime.fileMtimeMs = null;
	await ensureRuntime(pi, ctx);
}

// =============================================================================
// Mode matching / selection
// =============================================================================

type SelectionSnapshot = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	supportsThinking: boolean;
};

function getCurrentSelectionSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): SelectionSnapshot {
	const provider = lastObservedModel.provider ?? ctx.model?.provider;
	const modelId = lastObservedModel.modelId ?? ctx.model?.id;
	const thinkingLevel = pi.getThinkingLevel();

	let supportsThinking = Boolean(ctx.model?.reasoning);
	if (provider && modelId) {
		const model = ctx.modelRegistry.find(provider, modelId) as any;
		if (model) {
			supportsThinking = Boolean(model.reasoning);
		} else if (ctx.model?.provider === provider && ctx.model?.id === modelId) {
			supportsThinking = Boolean(ctx.model.reasoning);
		}
	}

	return { provider, modelId, thinkingLevel, supportsThinking };
}

function getCurrentSelectionSpec(pi: ExtensionAPI, ctx: ExtensionContext): ModeSpec {
	const s = getCurrentSelectionSnapshot(pi, ctx);
	return {
		provider: s.provider,
		modelId: s.modelId,
		thinkingLevel: s.thinkingLevel,
	};
}

function inferModeFromSelection(selection: SelectionSnapshot, data: ModesFile): string | null {
	const { provider, modelId, thinkingLevel, supportsThinking } = selection;
	if (!provider || !modelId) return null;

	const names = orderedModeNames(data.modes);
	if (supportsThinking) {
		for (const name of names) {
			const spec = data.modes[name];
			if (!spec) continue;
			if (spec.provider !== provider || spec.modelId !== modelId) continue;
			if ((spec.thinkingLevel ?? undefined) !== thinkingLevel) continue;
			return name;
		}
		return null;
	}

	const candidates: string[] = [];
	for (const name of names) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (spec.provider !== provider || spec.modelId !== modelId) continue;
		candidates.push(name);
	}
	if (candidates.length === 0) return null;

	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if ((spec.thinkingLevel ?? "off") === thinkingLevel) return name;
	}

	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (!spec.thinkingLevel) return name;
	}

	return candidates[0] ?? null;
}

function updateModeStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("modes", undefined);
}

async function syncModeFromCurrentSelection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.overlayEnabled) {
		customOverlay = null;
		if (ctx.hasUI) {
			requestEditorRender?.();
			updateModeStatus(ctx);
		}
		return;
	}

	const inferred = inferModeFromSelection(getCurrentSelectionSnapshot(pi, ctx), runtime.data);
	if (inferred) {
		runtime.currentMode = inferred;
		runtime.lastRealMode = inferred;
		customOverlay = null;
	} else {
		if (runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.lastRealMode = runtime.currentMode;
		}
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
	}

	if (ctx.hasUI) {
		requestEditorRender?.();
		updateModeStatus(ctx);
	}
}

async function storeSelectionIntoMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string, selection: ModeSpec): Promise<void> {
	if (mode === CUSTOM_MODE_NAME) return;

	await mutateModesFile(pi, ctx, (data) => {
		const existing = data.modes[mode] ?? {};
		const next: ModeSpec = { ...existing };
		if (selection.provider && selection.modelId) {
			next.provider = selection.provider;
			next.modelId = selection.modelId;
		}
		if (selection.thinkingLevel) {
			next.thinkingLevel = selection.thinkingLevel;
		}
		data.modes[mode] = next;
		ensureCurrentModeValid(data);
	});
}

async function applyMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	await ensureRuntime(pi, ctx);

	if (!runtime.overlayEnabled) {
		if (ctx.hasUI) {
			ctx.ui.notify("Mode overlay is disabled (modes.json has \"modes\": {}). Use /mode to configure.", "info");
		}
		return;
	}

	if (mode === CUSTOM_MODE_NAME) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
		if (ctx.hasUI) {
			requestEditorRender?.();
			updateModeStatus(ctx);
		}
		return;
	}

	const spec = runtime.data.modes[mode];
	if (!spec) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Unknown mode: ${mode}`, "warning");
		}
		return;
	}

	runtime.currentMode = mode;
	runtime.lastRealMode = mode;
	customOverlay = null;

	runtime.applying = true;
	let modelAppliedOk = true;
	try {
		if (spec.provider && spec.modelId) {
			const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (model) {
				const ok = await pi.setModel(model);
				modelAppliedOk = ok;
				if (ok) {
					// Keep an immediate, non-stale model snapshot even if ctx.model lags event delivery.
					lastObservedModel = { provider: spec.provider, modelId: spec.modelId };
				}
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
				}
			} else {
				modelAppliedOk = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Mode \"${mode}\" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
				}
			}
		}

		if (spec.thinkingLevel) {
			pi.setThinkingLevel(spec.thinkingLevel);
		}
	} finally {
		runtime.applying = false;
	}

	if (!modelAppliedOk) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
	} else {
		// Ensure model+thinking pairing still resolves exactly (handles clamping/overrides).
		await syncModeFromCurrentSelection(pi, ctx);
	}

	if (ctx.hasUI) {
		requestEditorRender?.();
		updateModeStatus(ctx);
	}
}

async function cycleModeNow(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.overlayEnabled) return;
	const names = orderedModeNames(runtime.data.modes);
	if (names.length === 0) return;

	const baseMode = runtime.currentMode === CUSTOM_MODE_NAME ? runtime.lastRealMode : runtime.currentMode;
	const idx = Math.max(0, names.indexOf(baseMode));
	const next = names[(idx + direction + names.length) % names.length] ?? names[0]!;
	await applyMode(pi, ctx, next);
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	const run = modeCycleQueue.then(() => cycleModeNow(pi, ctx, direction), () => cycleModeNow(pi, ctx, direction));
	modeCycleQueue = run.then(() => undefined, () => undefined);
	await run;
}

function isSimpleModeColor(value: string): value is SimpleModeColor {
	return (SIMPLE_MODE_COLORS as readonly string[]).includes(value);
}

function getModeBorderColor(ctx: ExtensionContext, pi: ExtensionAPI, mode: string): (text: string) => string {
	const theme = ctx.ui.theme;
	const spec = runtime.data.modes[mode];
	if (spec?.color) {
		if (isSimpleModeColor(spec.color)) {
			const ansi = SIMPLE_MODE_COLOR_ANSI[spec.color];
			return (text: string) => `${ansi}${text}\u001b[39m`;
		}
		// Backward compatibility with existing configs that store raw theme tokens.
		try {
			theme.getFgAnsi(spec.color as any);
			return (text: string) => theme.fg(spec.color as any, text);
		} catch {
			// fallthrough
		}
	}
	// Mirrors Pi's configured thinking border mapping (thinkingOff/thinkingLow/... theme tokens).
	return theme.getThinkingBorderColor(pi.getThinkingLevel());
}

function formatModeLabel(mode: string): string {
	return mode;
}

// =============================================================================
// UI: custom editor overlay
// =============================================================================

class ModePromptEditor extends CustomEditor {
	public modeLabelProvider?: () => string;
	public modeLabelColor?: (text: string) => string;
	public onSelectionChanged?: () => void;
	public getSelectionSnapshot?: () => string;

	private lockedBorder = false;
	private _borderColor?: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings);
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	handleInput(data: string): void {
		const before = this.getSelectionSnapshot?.() ?? "";
		super.handleInput(data);
		const after = this.getSelectionSnapshot?.() ?? "";
		if (before !== after) {
			this.onSelectionChanged?.();
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const mode = this.modeLabelProvider?.();
		if (!mode) return lines;

		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		const topPlain = stripAnsi(lines[0] ?? "");
		const scrollPrefixMatch = topPlain.match(/^(─── ↑ \d+ more )/);
		const prefix = scrollPrefixMatch?.[1] ?? "──";

		let label = formatModeLabel(mode);
		const labelLeftSpace = prefix.endsWith(" ") ? "" : " ";
		const labelRightSpace = " ";
		const minRightBorder = 1;
		const maxLabelLen = Math.max(0, width - prefix.length - labelLeftSpace.length - labelRightSpace.length - minRightBorder);
		if (maxLabelLen <= 0) return lines;
		if (label.length > maxLabelLen) label = label.slice(0, maxLabelLen);

		const labelChunk = `${labelLeftSpace}${label}${labelRightSpace}`;
		const remaining = width - prefix.length - labelChunk.length;
		if (remaining < 0) return lines;

		const right = "─".repeat(Math.max(0, remaining));
		const labelColor = this.modeLabelColor ?? ((text: string) => this.borderColor(text));
		lines[0] = this.borderColor(prefix) + labelColor(labelChunk) + this.borderColor(right);
		return lines;
	}

	public requestRenderNow(): void {
		this.tui.requestRender();
	}
}

function applyEditor(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	if (!runtime.overlayEnabled) {
		requestEditorRender = undefined;
		ctx.ui.setEditorComponent(undefined);
		updateModeStatus(ctx);
		return;
	}

	ctx.ui.setEditorComponent((tui, _theme, keybindings) => {
		const editor = new ModePromptEditor(tui, _theme, keybindings);
		requestEditorRender = () => editor.requestRenderNow();
		editor.modeLabelProvider = () => runtime.currentMode;
		editor.modeLabelColor = (text: string) => ctx.ui.theme.fg("dim", text);

		editor.getSelectionSnapshot = () => {
			const s = getCurrentSelectionSpec(pi, ctx);
			return `${s.provider ?? ""}/${s.modelId ?? ""}:${s.thinkingLevel ?? ""}`;
		};
		editor.onSelectionChanged = () => {
			void syncModeFromCurrentSelection(pi, ctx);
		};

		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			if (isBashMode) {
				return ctx.ui.theme.getBashModeBorderColor()(text);
			}
			return getModeBorderColor(ctx, pi, runtime.currentMode)(text);
		};

		editor.borderColor = borderColor;
		editor.lockBorderColor();
		return editor;
	});

	updateModeStatus(ctx);
}

// =============================================================================
// UI: mode management
// =============================================================================

function isReservedModeName(name: string): boolean {
	return name === CUSTOM_MODE_NAME || name === MODE_UI_CONFIGURE || name === MODE_UI_ADD || name === MODE_UI_BACK;
}

function normalizeModeNameInput(name: string | undefined): string {
	return (name ?? "").trim();
}

function validateModeNameOrError(
	name: string,
	existing: Record<string, ModeSpec>,
	opts?: { allowExisting?: boolean },
): string | null {
	if (!name) return "Mode name cannot be empty";
	if (/\s/.test(name)) return "Mode name cannot contain whitespace";
	if (isReservedModeName(name)) return `Mode name \"${name}\" is reserved`;
	if (!opts?.allowExisting && existing[name]) return `Mode \"${name}\" already exists`;
	return null;
}

async function pickModelForModeUI(
	ctx: ExtensionContext,
	spec: ModeSpec,
): Promise<{ provider: string; modelId: string } | undefined> {
	if (!ctx.hasUI) return undefined;

	const settingsManager = SettingsManager.inMemory();
	const currentModel = spec.provider && spec.modelId ? ctx.modelRegistry.find(spec.provider, spec.modelId) : ctx.model;
	const scopedModels: Array<{ model: any; thinkingLevel: string }> = [];

	return ctx.ui.custom<{ provider: string; modelId: string } | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			currentModel,
			settingsManager,
			ctx.modelRegistry as any,
			scopedModels as any,
			(model) => done({ provider: model.provider, modelId: model.id }),
			() => done(undefined),
		);
		return selector;
	});
}

async function pickThinkingLevelForModeUI(
	ctx: ExtensionContext,
	_current: ThinkingLevel | undefined,
): Promise<ThinkingLevel | null | undefined> {
	if (!ctx.hasUI) return undefined;

	const options = [...ALL_THINKING_LEVELS, THINKING_UNSET_LABEL];
	const choice = await ctx.ui.select("Thinking level", options);
	if (!choice) return undefined;
	if (choice === THINKING_UNSET_LABEL) return null;
	if (ALL_THINKING_LEVELS.includes(choice as ThinkingLevel)) return choice as ThinkingLevel;
	return undefined;
}

async function pickColorForModeUI(ctx: ExtensionContext, _current: string | undefined): Promise<string | null | undefined> {
	if (!ctx.hasUI) return undefined;

	const options = [COLOR_UNSET_LABEL, ...SIMPLE_MODE_COLORS];
	const choice = await ctx.ui.select("Border color", options);
	if (!choice) return undefined;
	if (choice === COLOR_UNSET_LABEL) return null;
	return choice;
}

function renameModesRecord(modes: Record<string, ModeSpec>, oldName: string, newName: string): Record<string, ModeSpec> {
	const out: Record<string, ModeSpec> = {};
	for (const [k, v] of Object.entries(modes)) {
		if (k === oldName) out[newName] = v;
		else out[k] = v;
	}
	return out;
}

async function addModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input("New mode name", "e.g. docs, review, planning");
		if (raw === undefined) return undefined;

		const name = normalizeModeNameInput(raw);
		const err = validateModeNameOrError(name, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		const selection = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
		await mutateModesFile(pi, ctx, (data) => {
			data.modes[name] = {
				provider: selection.provider,
				modelId: selection.modelId,
				thinkingLevel: selection.thinkingLevel,
			};
			if (!data.currentMode) data.currentMode = name;
		});

		await syncModeFromCurrentSelection(pi, ctx);
		applyEditor(pi, ctx);
		ctx.ui.notify(`Added mode \"${name}\"`, "info");
		return name;
	}
}

async function renameModeUI(pi: ExtensionAPI, ctx: ExtensionContext, oldName: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input(`Rename mode \"${oldName}\"`, oldName);
		if (raw === undefined) return undefined;

		const newName = normalizeModeNameInput(raw);
		if (!newName || newName === oldName) return oldName;

		const err = validateModeNameOrError(newName, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		await mutateModesFile(pi, ctx, (data) => {
			data.modes = renameModesRecord(data.modes, oldName, newName);
			if (data.currentMode === oldName) data.currentMode = newName;
		});

		if (runtime.currentMode === oldName) runtime.currentMode = newName;
		if (runtime.lastRealMode === oldName) runtime.lastRealMode = newName;

		await syncModeFromCurrentSelection(pi, ctx);
		applyEditor(pi, ctx);
		ctx.ui.notify(`Renamed \"${oldName}\" → \"${newName}\"`, "info");
		return newName;
	}
}

async function editModeUI(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	if (!ctx.hasUI) return;
	let modeName = mode;

	while (true) {
		await ensureRuntime(pi, ctx);
		if (!runtime.data.modes[modeName]) return;
		const spec = runtime.data.modes[modeName]!;

		const modelLabel = spec.provider && spec.modelId ? `${spec.provider}/${spec.modelId}` : "(no model)";
		const thinkingLabel = spec.thinkingLevel ?? THINKING_UNSET_LABEL;
		const colorLabel = spec.color ?? COLOR_UNSET_LABEL;

		const actions = ["Change name", "Change model", "Change thinking level", "Change border color", "Delete mode", MODE_UI_BACK];
		const action = await ctx.ui.select(
			`Edit mode \"${modeName}\"  model: ${modelLabel}  thinking: ${thinkingLabel}  color: ${colorLabel}`,
			actions,
		);
		if (!action || action === MODE_UI_BACK) return;

		if (action === "Change name") {
			const renamed = await renameModeUI(pi, ctx, modeName);
			if (renamed) modeName = renamed;
			continue;
		}

		if (action === "Change model") {
			const selected = await pickModelForModeUI(ctx, spec);
			if (!selected) continue;

			await mutateModesFile(pi, ctx, (data) => {
				const m = data.modes[modeName] ?? {};
				m.provider = selected.provider;
				m.modelId = selected.modelId;
				data.modes[modeName] = m;
			});

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			} else {
				await syncModeFromCurrentSelection(pi, ctx);
			}
			applyEditor(pi, ctx);
			ctx.ui.notify(`Updated model for \"${modeName}\"`, "info");
			continue;
		}

		if (action === "Change thinking level") {
			const level = await pickThinkingLevelForModeUI(ctx, spec.thinkingLevel);
			if (level === undefined) continue;

			await mutateModesFile(pi, ctx, (data) => {
				const m = data.modes[modeName] ?? {};
				if (level === null) delete m.thinkingLevel;
				else m.thinkingLevel = level;
				data.modes[modeName] = m;
			});

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			} else {
				await syncModeFromCurrentSelection(pi, ctx);
			}
			applyEditor(pi, ctx);
			ctx.ui.notify(`Updated thinking level for \"${modeName}\"`, "info");
			continue;
		}

		if (action === "Change border color") {
			const color = await pickColorForModeUI(ctx, spec.color);
			if (color === undefined) continue;

			await mutateModesFile(pi, ctx, (data) => {
				const m = data.modes[modeName] ?? {};
				if (color === null) delete m.color;
				else m.color = color;
				data.modes[modeName] = m;
			});

			requestEditorRender?.();
			ctx.ui.notify(`Updated border color for \"${modeName}\"`, "info");
			continue;
		}

		if (action === "Delete mode") {
			const ok = await ctx.ui.confirm("Delete mode", `Delete mode \"${modeName}\"?`);
			if (!ok) continue;

			await mutateModesFile(pi, ctx, (data) => {
				delete data.modes[modeName];
				ensureCurrentModeValid(data);
			});

			if (!runtime.overlayEnabled) {
				runtime.currentMode = CUSTOM_MODE_NAME;
				customOverlay = null;
			} else if (runtime.currentMode === modeName) {
				await syncModeFromCurrentSelection(pi, ctx);
			}
			if (runtime.lastRealMode === modeName) {
				runtime.lastRealMode = runtime.data.currentMode;
			}

			applyEditor(pi, ctx);
			ctx.ui.notify(`Deleted mode \"${modeName}\"`, "info");
			return;
		}
	}
}

async function configureModesUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const options = [...names, MODE_UI_ADD, MODE_UI_BACK];
		const title = runtime.overlayEnabled
			? `Configure modes (current: ${runtime.currentMode})`
			: "Configure modes (overlay disabled: modes is empty)";
		const choice = await ctx.ui.select(title, options);
		if (!choice || choice === MODE_UI_BACK) return;

		if (choice === MODE_UI_ADD) {
			const created = await addModeUI(pi, ctx);
			if (created) {
				await editModeUI(pi, ctx, created);
			}
			continue;
		}


		await editModeUI(pi, ctx, choice);
	}
}

async function handleModeChoiceUI(pi: ExtensionAPI, ctx: ExtensionContext, choice: string): Promise<void> {
	if (runtime.currentMode === CUSTOM_MODE_NAME && choice !== CUSTOM_MODE_NAME) {
		const action = await ctx.ui.select(`Mode \"${choice}\"`, ["use", "store"]);
		if (!action) return;

		if (action === "use") {
			await applyMode(pi, ctx, choice);
			return;
		}

		const overlay = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
		await storeSelectionIntoMode(pi, ctx, choice, overlay);
		await applyMode(pi, ctx, choice);
		ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into \"${choice}\"`, "info");
		return;
	}

	await applyMode(pi, ctx, choice);
}

async function selectModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);

		if (!runtime.overlayEnabled) {
			const choice = await ctx.ui.select("Mode overlay disabled", [MODE_UI_CONFIGURE, MODE_UI_BACK]);
			if (!choice || choice === MODE_UI_BACK) return;
			await configureModesUI(pi, ctx);
			continue;
		}

		const names = orderedModeNames(runtime.data.modes);
		const choice = await ctx.ui.select(`Mode (current: ${runtime.currentMode})`, [...names, MODE_UI_CONFIGURE]);
		if (!choice) return;

		if (choice === MODE_UI_CONFIGURE) {
			await configureModesUI(pi, ctx);
			continue;
		}

		await handleModeChoiceUI(pi, ctx, choice);
		return;
	}
}

// =============================================================================
// Extension export
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mode", {
		description: "Select and configure prompt modes",
		handler: async (args, ctx) => {
			const tokens = args
				.split(/\s+/)
				.map((x) => x.trim())
				.filter(Boolean);

			if (tokens.length === 0) {
				await selectModeUI(pi, ctx);
				return;
			}

			if (tokens[0] === "configure") {
				await configureModesUI(pi, ctx);
				return;
			}


			if (tokens[0] === "store") {
				await ensureRuntime(pi, ctx);
				if (!runtime.overlayEnabled) {
					if (ctx.hasUI) ctx.ui.notify("Mode overlay is disabled; add a mode first in /mode configure", "warning");
					return;
				}

				let target = tokens[1];
				if (!target) {
					if (!ctx.hasUI) return;
					const names = orderedModeNames(runtime.data.modes);
					target = await ctx.ui.select("Store current selection into mode", names);
					if (!target) return;
				}

				if (target === CUSTOM_MODE_NAME) {
					if (ctx.hasUI) ctx.ui.notify(`Cannot store into \"${CUSTOM_MODE_NAME}\"`, "warning");
					return;
				}

				const selection = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
				await storeSelectionIntoMode(pi, ctx, target, selection);
				if (ctx.hasUI) ctx.ui.notify(`Stored current selection into \"${target}\"`, "info");
				await syncModeFromCurrentSelection(pi, ctx);
				requestEditorRender?.();
				return;
			}

			await applyMode(pi, ctx, tokens[0]!);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Select prompt mode",
		handler: async (ctx) => {
			await ensureRuntime(pi, ctx);
			if (!runtime.overlayEnabled) return;
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+space", {
		description: "Cycle prompt mode",
		handler: async (ctx) => {
			await ensureRuntime(pi, ctx);
			if (!runtime.overlayEnabled) return;
			await cycleMode(pi, ctx, 1);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		await ensureRuntime(pi, ctx);
		await syncModeFromCurrentSelection(pi, ctx);
		applyEditor(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		await ensureRuntime(pi, ctx);
		await syncModeFromCurrentSelection(pi, ctx);
		applyEditor(pi, ctx);
	});

	pi.on("model_select", async (event: any, ctx) => {
		lastObservedModel = { provider: event.model.provider, modelId: event.model.id };
		if (runtime.applying) return;
		await syncModeFromCurrentSelection(pi, ctx);
	});

	// Catch non-model selection changes (e.g. thinking level tweaks from other paths)
	// before each agent run.
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncModeFromCurrentSelection(pi, ctx);
	});
}
