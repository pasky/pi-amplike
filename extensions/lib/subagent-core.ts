/**
 * Shared subagent infrastructure.
 *
 * Used by both the subagent tool (subagent.ts) and the /btw command (btw.ts).
 * Contains the core runner, types, rendering helpers, and TUI rendering.
 */

import {
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	getMarkdownTheme,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { loadAmplikeSettings, resolveBashAction } from "./permissions-core.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MINIBOX_LINES = 10;
// Max lines of the task/input prompt to show in any rendered view. A /review
// task embeds the entire `git log` inside a ```…``` block, which can be hundreds
// of lines; rendering it in full makes the (live-updating) progress widget span
// the whole screen and flicker badly next to concurrent agent output. The full
// task is always preserved in the session — this only clamps what's displayed.
export const TASK_DISPLAY_LINES = 10;
// Expanded/finished views (transcript, btw result) are not live-updating, so
// flicker isn't a concern there; they get a much larger budget so "Ctrl+O to
// expand" still reveals essentially the whole input.
export const TASK_DISPLAY_LINES_EXPANDED = 60;

/**
 * Clamp a task/input prompt to at most `maxLines` TOTAL displayed lines (the
 * "… +N more lines" marker is counted against the budget, so the result never
 * exceeds it). Trailing blank lines are dropped first so they don't get reported
 * as omitted content. Used everywhere the raw task is shown so an oversized
 * input (e.g. a /review commit log) can't blow up the view.
 */
export function clampTaskForDisplay(task: string, maxLines = TASK_DISPLAY_LINES): string {
	const lines = task.replace(/\s+$/, "").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	const kept = Math.max(1, maxLines - 1); // reserve one line for the marker
	return `${lines.slice(0, kept).join("\n")}\n… +${lines.length - kept} more lines`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	task: string;
	exitCode: number;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	/**
	 * Requested mode/model badge (e.g. "deep", "anthropic/claude-haiku-4-5"),
	 * shown next to the task in the UI. Only set when the caller explicitly asked
	 * for a mode and/or model — an unset badge means "inherits the parent's".
	 */
	agentBadge?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Subagent session id (persisted) for follow-up session-query. */
	sessionId?: string;
	/** Path to the persisted subagent session file, if any. */
	sessionFile?: string;
}

export interface SubagentDetails {
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

/** Hard cap per badge component, so a bogus request can't blow up the header. */
const BADGE_PART_MAX = 40;

function sanitizeBadgePart(s: string): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > BADGE_PART_MAX ? `${flat.slice(0, BADGE_PART_MAX - 1)}…` : flat;
}

/**
 * Build the mode/model badge shown next to a subagent in the UI. `mode`/`model`
 * must be the overrides that ACTUALLY applied (see resolveModelAndThinking's
 * `applied`); `unresolved` requests are shown separately as ignored, so the
 * badge never claims a model the subagent isn't running. Returns undefined when
 * nothing was explicitly requested (so nothing is rendered).
 */
export function formatAgentBadge(opts: {
	mode?: string;
	model?: string;
	unresolved?: string[];
}): string | undefined {
	const parts = [opts.mode, opts.model]
		.filter((s): s is string => !!s && !!s.trim())
		.map(sanitizeBadgePart);
	const ignored = (opts.unresolved ?? [])
		.filter((s) => !!s && !!s.trim())
		.map(sanitizeBadgePart);
	if (ignored.length) parts.push(`⚠ ignored ${ignored.join(" ")}`);
	return parts.length ? parts.join(" ") : undefined;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Path / tool-call formatting
// ---------------------------------------------------------------------------

export function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			let cmd = (args.command as string) || "...";
			const home = os.homedir();
			cmd = cmd.replaceAll(home, "~");
			const firstLine = cmd.split("\n")[0];
			return fg("muted", "$ ") + fg("toolOutput", firstLine);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// TUI rendering: shared building blocks
// ---------------------------------------------------------------------------

/**
 * Render a single result as a collapsed "minibox" string.
 * Shows icon, optional task preview, error, last N tool calls/text, and usage.
 * Used by both subagent tool (collapsed view) and btw (collapsed view).
 */
export function renderMinibox(
	r: SingleResult,
	options: { showTask: boolean; expanded: boolean },
	theme: Theme,
): string {
	const isRunning = r.exitCode === -1;
	const isError = r.exitCode > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: isError
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const lines: string[] = [];

	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";

	if (options.showTask) {
		// Clamp the task to a few lines (see clampTaskForDisplay) so an oversized
		// input can't blow the minibox up to full-screen and flicker.
		lines.push(`${icon} ${badge}${theme.fg("dim", clampTaskForDisplay(r.task))}`);
	} else {
		lines.push(badge ? `${icon} ${badge.trimEnd()}` : icon);
	}

	if (isError && r.errorMessage) {
		lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	}

	const items = r.displayItems;
	const itemsToShow = options.expanded ? items : items.slice(-MINIBOX_LINES);
	const skipped = items.length - itemsToShow.length;

	if (skipped > 0) {
		lines.push(theme.fg("muted", `... ${skipped} earlier items`));
	}

	for (const item of itemsToShow) {
		if (item.type === "text") {
			if (options.expanded) {
				continue;
			}
			const textLines = item.text.split("\n").filter((l) => l.trim());
			const preview = textLines.slice(0, 5).join("\n");
			lines.push(theme.fg("toolOutput", preview));
			if (textLines.length > 5) lines.push(theme.fg("muted", `... +${textLines.length - 5} lines`));
		} else {
			lines.push(
				theme.fg("muted", "→ ") +
					formatToolCall(item.name, item.args, theme.fg.bind(theme)),
			);
		}
	}

	if (!isRunning) {
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) lines.push(theme.fg("dim", usageStr));
	}

	return lines.join("\n");
}

/**
 * Render a single result in expanded form as TUI components added to a container.
 * Shows separator + icon + task + all tool calls + markdown output + usage.
 * Used by both subagent tool (expanded view) and btw (expanded view).
 */
export function renderResultExpanded(
	r: SingleResult,
	container: Container,
	theme: Theme,
	mdTheme: MarkdownTheme,
): void {
	const rIcon = r.exitCode === 0
		? theme.fg("success", "✓")
		: r.exitCode === -1
			? theme.fg("warning", "⏳")
			: theme.fg("error", "✗");

	container.addChild(new Spacer(1));
	// Clamp the task prompt (see clampTaskForDisplay) so an oversized input can't
	// dominate the transcript.
	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";
	container.addChild(
		new Text(
			`${theme.fg("muted", "─── ")}${rIcon} ${badge}${theme.fg("dim", clampTaskForDisplay(r.task, TASK_DISPLAY_LINES_EXPANDED))}`,
			0, 0,
		),
	);

	if (r.exitCode > 0 && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	for (const item of r.displayItems) {
		if (item.type === "toolCall") {
			container.addChild(new Text(
				theme.fg("muted", "→ ") +
					formatToolCall(item.name, item.args, theme.fg.bind(theme)),
				0, 0,
			));
		}
	}

	if (r.finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
	}

	const taskUsage = formatUsage(r.usage, r.model);
	if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
}

/**
 * Render a list of results as a complete TUI component.
 * Handles both collapsed and expanded views, single and multi-task.
 * Used by both subagent tool renderResult and btw message renderer.
 *
 * @param label - The label to show in the header (e.g. "subagent" or "btw")
 */
export function renderResults(
	results: SingleResult[],
	options: { expanded: boolean; label: string },
	theme: Theme,
): Component {
	const mdTheme = getMarkdownTheme();

	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const failCount = results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: results.length === 1
			? ""
			: `${successCount}/${results.length} tasks`;

	// --- Expanded view (only when finished) ---
	if (options.expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`,
				0, 0,
			),
		);

		for (const r of results) {
			renderResultExpanded(r, container, theme, mdTheme);
		}

		if (results.length > 1) {
			const totalUsage = aggregateUsage(results);
			const totalStr = formatUsage(totalUsage);
			if (totalStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
			}
		}

		return container;
	}

	// --- Collapsed / running view ---
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`;
	for (const r of results) {
		text += `\n\n${renderMinibox(r, { showTask: true, expanded: options.expanded }, theme)}`;
	}
	if (!isRunning && results.length > 1) {
		const totalUsage = aggregateUsage(results);
		const totalStr = formatUsage(totalUsage);
		if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
	}
	if (!options.expanded && !isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

/**
 * Render a result as plain-text lines (no theme colors).
 * Used for setWidget() which only supports string[].
 */
export function btwTaskPreview(task: string): string {
	const taskFirstLine = task.split("\n")[0];
	const taskMultiline = taskFirstLine.length < task.length;
	const maxLen = (process.stdout.columns ?? 120) - "⏳ btw: ".length - 3 - 5;
	const taskTrimmed = taskFirstLine.length > maxLen ? `${taskFirstLine.slice(0, maxLen)}...` : taskFirstLine;
	return taskMultiline && !taskTrimmed.endsWith("...") ? `${taskTrimmed}...` : taskTrimmed;
}

export function renderProgressPlainLines(task: string, result: SingleResult): string[] {
	const taskPreview = btwTaskPreview(task);
	const lines: string[] = [];

	// Mirror the finished view's `[mode/model]` badge in the live widget — that's
	// the longest-lived UI state for a /btw run.
	lines.push(`⏳ btw: ${result.agentBadge ? `[${result.agentBadge}] ` : ""}${taskPreview}`);

	const items = result.displayItems;
	const itemsToShow = items.slice(-MINIBOX_LINES);
	const skipped = items.length - itemsToShow.length;

	if (skipped > 0) {
		lines.push(`  ... ${skipped} earlier items`);
	}

	for (const item of itemsToShow) {
		if (item.type === "text") {
			const textLines = item.text.split("\n").filter((l) => l.trim());
			const preview = textLines.slice(0, 3).join("\n  ");
			lines.push(`  ${preview}`);
			if (textLines.length > 3) lines.push(`  ... +${textLines.length - 3} lines`);
		} else {
			switch (item.name) {
				case "bash": {
					const cmd = (item.args.command as string) || "...";
					lines.push(`  $ ${cmd.split("\n")[0]}`);
					break;
				}
				case "read":
					lines.push(`  read ${item.args.file_path || item.args.path || "..."}`);
					break;
				case "write":
					lines.push(`  write ${item.args.file_path || item.args.path || "..."}`);
					break;
				case "edit":
					lines.push(`  edit ${item.args.file_path || item.args.path || "..."}`);
					break;
				default:
					lines.push(`  → ${item.name}`);
			}
		}
	}

	return lines;
}

// ---------------------------------------------------------------------------
// Core: run a single subagent loop
// ---------------------------------------------------------------------------

// Completion-detection tuning. AgentSession changes `isStreaming` WITHOUT
// emitting an event (observed: agent_end fires while still streaming, then the
// flag clears silently), so we must poll. SETTLE_MS is how often we re-check.
const SETTLE_MS = 150;
// After compaction_end{willRetry} / auto_retry_start, AgentSession continues the
// loop via an internal `setTimeout(continue, 100)`. We hold a deterministic
// `pendingContinue` flag across that gap; CONTINUE_GRACE_MS only bounds the
// silent/no-op case where the continuation never actually starts. It must
// comfortably exceed that internal 100ms.
const CONTINUE_GRACE_MS = 700;
// A threshold compaction (willRetry:false) can land as a subagent turn's terminal
// event, ending the turn before the model emits its final answer. Interactive pi
// relies on the human pressing enter to continue; a subagent has nobody, so we
// nudge it ourselves. Capped to avoid a think→length→compact→nudge spiral.
const MAX_RESUME_NUDGES = 3;
const RESUME_NUDGE_TEXT =
	"Context was compacted mid-turn. Continue from where you left off.";
// Prepended when we surface a compaction summary as the subagent's output (the
// nudge budget was exhausted). Marks it as recovered progress, not a real answer.
const FALLBACK_SUMMARY_PREFIX =
	"⚠ Subagent ran out of context before writing a final answer; its latest compaction summary follows.";

/**
 * A `bash` tool that enforces amp permissions before executing. Subagents have
 * no UI, so anything that isn't auto-`allow`ed (i.e. `ask`/`deny`/`reject`) is
 * blocked rather than silently bypassing the policy the parent session enforces.
 * Registered via `customTools` (name "bash"), which overrides the built-in bash
 * in AgentSession's tool registry — no extension binding required.
 *
 * Blocking THROWS (rather than returning {isError:true}): pi-agent-core only
 * marks a tool result as an error when execute throws, so a returned isError
 * would be reported to the model as a successful call.
 *
 * Shell settings (path/prefix) are threaded through so subagent bash matches the
 * parent's shell semantics (aliases, command prefix, custom shell).
 */
export function createGatedBashDefinition(
	cwd: string,
	shellOptions?: { shellPath?: string; commandPrefix?: string },
): any {
	const base = createBashToolDefinition(cwd, {
		shellPath: shellOptions?.shellPath,
		commandPrefix: shellOptions?.commandPrefix,
	});
	return {
		...base,
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			const command = String(params?.command ?? "");
			const yolo = loadAmplikeSettings().permissions?.mode === "yolo";
			if (!yolo) {
				const action = resolveBashAction(command, cwd);
				if (action !== "allow") {
					throw new Error(
						`Blocked by amp permissions (action: ${action}). Subagents run non-interactively, so only auto-allowed commands execute. Run this in the main session or adjust amp.permissions.`,
					);
				}
			}
			return base.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

// ---------------------------------------------------------------------------
// Opt-in extensions for subagent sessions
// ---------------------------------------------------------------------------

/**
 * Extensions the user asked to load into subagent sessions (`amplike.json`:
 * `subagent.extensions`), resolved to absolute paths.
 *
 * Subagents load no extensions by default (see runSubagent), which also silently
 * disables anything that configures the session from `before_agent_start` — most
 * notably a system prompt chosen per model/provider. That can't be papered over
 * from the outside: the RIGHT prompt for a subagent depends on the subagent's own
 * model, which may differ from the session's (`mode`/`model` args), so the only
 * thing that can compute it is the extension itself, running in the subagent's
 * session where `ctx.model` is the subagent's model.
 *
 * So amplike offers what pi's CLI already offers as `--no-extensions --extension
 * <path>`: nothing is discovered, only what the user explicitly listed is loaded.
 * Opt-in, because loading an extension into a second in-process session is only
 * safe for extensions that keep no per-session state at module scope (pi caches
 * extension factories per path, so parent and subagent share one module
 * instance) — a property only the user can vouch for. Amplike itself stays
 * ignorant of what the listed extensions do.
 *
 * Relative paths resolve against `agentDir` (~/.pi/agent) rather than the cwd, so
 * a global "extensions/foo.ts" means the same thing in every project; `~` is
 * expanded. Missing paths are left to pi, which reports them as load errors.
 */
export function subagentExtensionPaths(
	settings: { subagent?: { extensions?: string[] } } | undefined,
	agentDir: string,
): string[] {
	const configured = settings?.subagent?.extensions;
	if (!Array.isArray(configured)) return [];
	return configured
		.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
		.map((p) => {
			const raw = p.trim();
			if (raw === "~") return os.homedir();
			if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
			return path.resolve(agentDir, raw);
		});
}

export interface SettleController {
	/** Feed a session event (only type/willRetry are inspected). */
	onEvent(event: { type?: string; willRetry?: boolean }): void;
	/** Re-check for completion now (e.g. after prompt() resolves). */
	kick(): void;
	/** Resolves once the session is judged settled (idle + no pending continue). */
	done: Promise<void>;
	dispose(): void;
}

/**
 * Completion barrier for an AgentSession-like object, factored out so it can be
 * unit-tested deterministically (see test). Rationale (all observed):
 *  - AgentSession's `isStreaming` clears WITHOUT an event -> we must poll.
 *  - overflow/retry continue the loop via an internal `setTimeout(continue,100)`
 *    after compaction_end{willRetry}/auto_retry_start, with nothing "busy" in
 *    between -> we hold `pendingContinue` from that event until the
 *    continuation's agent_start/message_start, bounding the silent/no-op case
 *    with `graceMs`.
 *
 * `isBusy()` reports session-level busy flags only (NOT pendingContinue).
 */
export function createSettleController(opts: {
	isBusy: () => boolean;
	settleMs?: number;
	graceMs?: number;
}): SettleController {
	const settleMs = opts.settleMs ?? SETTLE_MS;
	const graceMs = opts.graceMs ?? CONTINUE_GRACE_MS;
	let resolveDone!: () => void;
	const done = new Promise<void>((r) => {
		resolveDone = r;
	});
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingContinue = false;
	let disposed = false;

	const clearPending = () => {
		pendingContinue = false;
		if (graceTimer) {
			clearTimeout(graceTimer);
			graceTimer = undefined;
		}
	};
	const busy = () => pendingContinue || opts.isBusy();
	const arm = () => {
		if (disposed) return;
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			if (disposed) return;
			if (busy()) arm();
			else resolveDone();
		}, settleMs);
	};
	const markPendingContinue = () => {
		pendingContinue = true;
		if (graceTimer) clearTimeout(graceTimer);
		graceTimer = setTimeout(() => {
			pendingContinue = false;
			graceTimer = undefined;
			arm();
		}, graceMs);
	};

	return {
		onEvent(event) {
			switch (event?.type) {
				case "agent_start":
				case "message_start":
					// A (possibly continued) turn actually started; the gap is over.
					clearPending();
					break;
				case "compaction_end":
					if (event.willRetry) markPendingContinue();
					break;
				case "auto_retry_start":
					markPendingContinue();
					break;
			}
			arm();
		},
		kick() {
			arm();
		},
		done,
		dispose() {
			disposed = true;
			if (settleTimer) clearTimeout(settleTimer);
			clearPending();
		},
	};
}

function resolveAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) {
		if (env === "~") return os.homedir();
		if (env.startsWith("~/")) return path.join(os.homedir(), env.slice(2));
		return env;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export interface RunSubagentOptions {
	/** Working directory for tool execution and resource discovery. */
	cwd: string;
	/** Model registry (for auth + model discovery). */
	modelRegistry: any;
	/** Target model object (pi-ai Model). */
	model: any;
	/** Thinking/reasoning level. */
	thinkingLevel: string;
	/** The task prompt. */
	task: string;
	/** Optional mode/model badge to surface in the UI (see SingleResult.agentBadge). */
	agentBadge?: string;
	/** Parent session file path, to thread the subagent session under it. */
	parentSessionFile?: string;

	/** Optional abort signal. */
	signal?: AbortSignal;
	/** Progress callback, fired on each message/tool/compaction event. */
	onProgress: (result: SingleResult) => void;
}

// ---------------------------------------------------------------------------
// Resume-decision logic (pure, exported for testing). Extracted so the subtle
// "subagent stalled on a terminal threshold compaction" handling can be unit-
// tested without a live AgentSession (see test/resume-decision.test.mjs).
// ---------------------------------------------------------------------------

/** Concatenated text of the latest assistant message ("" if none / no text). */
export function lastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			return (messages[i].content || [])
				.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("");
		}
	}
	return "";
}

export interface CompactionInfo {
	willRetry: boolean;
	reason?: string;
	aborted: boolean;
	summary?: string;
}

/**
 * The resumable stall: a SUCCESSFUL threshold compaction (has a summary) that
 * the runtime won't auto-continue (willRetry:false) and which no human is
 * present to resume. Excludes:
 *   - overflow compactions (willRetry:true — already auto-continued),
 *   - aborted compactions (user cancelled),
 *   - FAILED compactions (result/summary undefined — context still full, so a
 *     nudge is futile and would emit a misleading "context was compacted").
 */
export function isTerminalThresholdCompaction(c: CompactionInfo | undefined): boolean {
	return !!c && !c.willRetry && c.reason === "threshold" && !c.aborted && !!c.summary;
}

export type ResumeDecision =
	| { action: "done"; output: string }
	| { action: "nudge" }
	| { action: "fallback"; output: string }
	| { action: "empty" };

/**
 * Decide what to do after a subagent turn settles.
 *  - done:     the turn produced final text -> use it.
 *  - nudge:    stalled on a resumable terminal threshold compaction, budget left.
 *  - fallback: stalled, nudge budget exhausted -> surface the compaction summary.
 *  - empty:    nothing usable. Includes error/abort: we deliberately do NOT
 *              fabricate a summary under a failed/aborted run (the parent renders
 *              those as failures; a summary body would read as a fake answer).
 */
export function decideResume(args: {
	finalText: string;
	lastCompaction: CompactionInfo | undefined;
	nudges: number;
	maxNudges: number;
	stopReason?: string;
	aborted?: boolean;
}): ResumeDecision {
	const { finalText, lastCompaction, nudges, maxNudges, stopReason, aborted } = args;
	if (finalText) return { action: "done", output: finalText };
	if (!isTerminalThresholdCompaction(lastCompaction)) return { action: "empty" };
	// Error/abort: surface the failure cleanly, no fabricated output. Both the
	// abort signal and an "aborted" stopReason count (the latter can be set on a
	// turn aborted mid-stream even before the outer signal check runs).
	if (stopReason === "error" || stopReason === "aborted" || aborted) return { action: "empty" };
	if (nudges < maxNudges) return { action: "nudge" };
	// Budget exhausted on an otherwise-healthy stall: summary guaranteed present.
	return { action: "fallback", output: lastCompaction!.summary! };
}

/**
 * Run a single subagent using a full AgentSession.
 *
 * Unlike a bare agentLoop, AgentSession brings the complete orchestration that
 * the interactive/print/rpc run modes use: threshold compaction, overflow
 * recovery (compact+retry when the context window is exceeded), and auto-retry
 * on transient errors. The subagent is just another headless "run mode" over
 * AgentSession.
 *
 * Isolation: discovered extensions are NOT loaded (`noExtensions`). Extensions
 * hold module-level state and register on a shared runtime, so binding the full
 * set inside a second in-process session corrupts the PARENT session's extensions
 * (observed: a parent widget callback hitting a stale ctx crashed the host).
 * Loading none keeps the subagent to the four built-in tools. Running the full
 * extension set safely would require a separate process. The session is still
 * persisted, so it stays queryable.
 *
 * The exception is extensions the user explicitly opted in for subagents (see
 * subagentExtensionPaths) — exactly pi's own `--no-extensions --extension <path>`
 * semantics. That's how session-configuring extensions (notably a system prompt
 * chosen per model/provider) reach subagents: they run IN the subagent session,
 * so they see the subagent's own model, which a parent-side mechanism could never
 * get right for a subagent running a different model.
 *
 * Because the permissions extension is not loaded, bash would otherwise bypass
 * amp's allow/ask/deny policy; we re-enforce it via a gated `bash` customTool
 * (createGatedBashDefinition) that overrides the built-in.
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SingleResult> {
	const { cwd, modelRegistry, model, thinkingLevel, task, agentBadge, parentSessionFile, signal, onProgress } = opts;

	const result: SingleResult = {
		task,
		exitCode: -1,
		displayItems: [],
		finalOutput: "",
		usage: emptyUsage(),
		model: `${model.provider}/${model.id}`,
		agentBadge,
	};

	// Abort before we even start.
	if (signal?.aborted) {
		result.exitCode = 1;
		result.stopReason = "aborted";
		result.errorMessage = "aborted before start";
		return result;
	}

	const subagentTask = [
		"You are operating as a subagent within a larger agent session.",
		"Complete the following task thoroughly, then provide your final response as text.",
		"Be concise and focused.",
		"",
		task,
	].join("\n");

	const agentDir = resolveAgentDir();
	let session: any;
	let unsubscribe: (() => void) | undefined;
	let onAbort: (() => void) | undefined;
	let settle: SettleController | undefined;
	// Most recent compaction's disposition, so the post-settle resume loop can
	// distinguish a terminal threshold compaction (willRetry:false, nothing
	// auto-continues it) from an overflow compaction that resumes on its own.
	let lastCompaction:
		| { willRetry: boolean; reason?: string; aborted: boolean; summary?: string }
		| undefined;

	try {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			// Isolation: discover no extensions (see function doc)...
			noExtensions: true,
			// ...but honour the ones the user opted in for subagents. With
			// noExtensions this is an allowlist, exactly like pi's own
			// `--no-extensions --extension <path>`.
			additionalExtensionPaths: subagentExtensionPaths(loadAmplikeSettings(), agentDir),
		});
		await resourceLoader.reload();

		// Persisted (not in-memory) so the subagent transcript is queryable later.
		// Thread it under the parent session (mirrors AgentSessionRuntime.newSession).
		const sessionManager = SessionManager.create(cwd);
		if (parentSessionFile) {
			sessionManager.newSession({ parentSession: parentSessionFile });
		}

		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry,
			model,
			thinkingLevel: thinkingLevel as any,
			sessionManager,
			// Override the built-in bash with a permission-gated one (no extensions
			// loaded means the permissions extension can't gate it otherwise). Thread
			// shell settings through so semantics match the parent's built-in bash.
			customTools: [createGatedBashDefinition(cwd, {
				shellPath: settingsManager.getShellPath?.(),
				commandPrefix: settingsManager.getShellCommandPrefix?.(),
			})],
			resourceLoader,
			settingsManager,
		});
		session = created.session;
		// No UI bindings: pi falls back to its no-op UI context, so an opted-in
		// extension calling ui.setStatus()/notify() here is inert rather than
		// reaching into the parent's TUI.
		await session.bindExtensions({});

		// A mistyped subagent.extensions entry would otherwise fail silently (pi
		// collects load errors instead of throwing), leaving the subagent quietly
		// unconfigured. Surface it where the run is visible.
		for (const err of created.extensionsResult?.errors ?? []) {
			result.displayItems.push({
				type: "text",
				text: `⚠ subagent extension not loaded: ${err.path}: ${err.error}`,
			});
		}

		result.sessionId = session.sessionManager.getSessionId();
		result.sessionFile = session.sessionManager.getSessionFile();

		// Compute usage the same way pi's status bar does: cumulative over ALL
		// assistant entries (survives compaction, monotonic), and context size via
		// getContextUsage() (correct after compaction).
		const syncUsage = () => {
			try {
				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let cost = 0;
				let turns = 0;
				for (const entry of session.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const u = entry.message.usage;
						if (u) {
							input += u.input || 0;
							output += u.output || 0;
							cacheRead += u.cacheRead || 0;
							cacheWrite += u.cacheWrite || 0;
							cost += u.cost?.total || 0;
						}
						turns++;
					}
				}
				result.usage.input = input;
				result.usage.output = output;
				result.usage.cacheRead = cacheRead;
				result.usage.cacheWrite = cacheWrite;
				result.usage.cost = cost;
				result.usage.turns = turns;
				const ctx = session.getContextUsage();
				if (ctx?.tokens != null) result.usage.contextTokens = ctx.tokens;
			} catch {
				/* best-effort */
			}
		};

		const report = () => {
			try {
				syncUsage();
				onProgress(result);
			} catch {
				// A throwing progress/UI callback must never break the barrier or the
				// session's event processing.
			}
		};

		// Completion barrier — see createSettleController. prompt() resolves before
		// overflow compaction+retry finishes, and isStreaming flips silently, so we
		// poll session flags + hold pendingContinue across the continue gap.
		const isBusy = () =>
			session.isStreaming ||
			session.isCompacting ||
			session.isRetrying ||
			session.pendingMessageCount > 0 ||
			session.isBashRunning ||
			session.hasPendingBashMessages;
		// Each prompt/continue needs its own barrier: `settle.done` is a one-shot
		// promise (resolves once), so reusing it across resume-nudges would return
		// instantly. armSettle() disposes the previous controller and installs a
		// fresh one; the subscriber reads `settle` from this scope, so the existing
		// subscription automatically feeds whichever controller is current.
		const armSettle = () => {
			settle?.dispose();
			settle = createSettleController({ isBusy });
			return settle;
		};
		armSettle();

		unsubscribe = session.subscribe((event: any) => {
			switch (event.type) {
				case "message_end": {
					const msg = event.message as any;
					if (msg.role === "assistant") {
						if (msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;

						for (const part of msg.content) {
							if (part.type === "text") {
								result.displayItems.push({ type: "text", text: part.text });
								result.finalOutput = part.text;
							} else if (part.type === "toolCall") {
								result.displayItems.push({
									type: "toolCall",
									name: part.name,
									args: part.arguments,
								});
							}
						}
					}
					break;
				}
				case "compaction_start": {
					result.displayItems.push({ type: "text", text: `↯ compacting context (${event.reason})…` });
					break;
				}
				case "compaction_end": {
					lastCompaction = {
						willRetry: !!event.willRetry,
						reason: event.reason,
						aborted: !!event.aborted,
						summary: event.result?.summary,
					};
					break;
				}
				case "agent_start":
				case "message_start": {
					// A (possibly continued) turn started — any prior compaction was
					// resumed, so it's no longer the turn's terminal event.
					lastCompaction = undefined;
					break;
				}
			}
			report();
			settle?.onEvent(event); // barrier bookkeeping (pendingContinue + re-arm)
		});

		onAbort = () => {
			// abort() stops the current run/retry but NOT auto-compaction; abort both.
			try {
				session.abortCompaction();
			} catch {
				/* best-effort */
			}
			void session.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		// Re-check: the signal may have fired during the async setup above, before
		// the listener was attached.
		if (signal?.aborted) {
			onAbort();
			throw new Error("aborted during setup");
		}

		// Read authoritative final state from the session (our subscriber capture
		// can lag the async event queue).
		const readFinalState = () => {
			try {
				const msgs: any[] = session.state?.messages ?? [];
				for (let i = msgs.length - 1; i >= 0; i--) {
					if (msgs[i]?.role === "assistant") {
						const m = msgs[i];
						if (m.model) result.model = m.model;
						if (m.stopReason) result.stopReason = m.stopReason;
						result.errorMessage = m.errorMessage || result.errorMessage;
						break;
					}
				}
				// Authoritative: reflect ONLY the latest assistant turn's text, even when
				// empty. The streaming subscriber sets finalOutput on every text part
				// (including intermediate "let me inspect…" preambles before tool calls);
				// overwriting-when-empty here prevents such a fragment from lingering and
				// falsely satisfying the resume gate / suppressing the fallback.
				result.finalOutput = lastAssistantText(msgs);
			} catch {
				/* fall back to subscriber-captured values */
			}
		};

		await session.prompt(subagentTask, { source: "extension" });
		settle!.kick();
		await settle!.done;
		readFinalState();

		// Resume loop. A successful threshold compaction (willRetry:false) can end a
		// subagent turn before the final answer is emitted; the runtime won't auto-
		// continue it and there's no human to press enter, so we nudge — capped to
		// bound the worst case, with the compaction summary as a last-resort output.
		// All branch logic lives in decideResume() (pure + unit-tested).
		let nudges = 0;
		for (;;) {
			const decision = decideResume({
				finalText: result.finalOutput,
				lastCompaction,
				nudges,
				maxNudges: MAX_RESUME_NUDGES,
				stopReason: result.stopReason,
				aborted: !!signal?.aborted,
			});
			if (decision.action === "done" || decision.action === "empty") break;
			if (decision.action === "fallback") {
				// Label provenance: the summary is a progress doc, not a polished
				// answer. Without this the parent renders `[✓] <summary>` as if it were
				// the subagent's actual final response.
				const labeled = `${FALLBACK_SUMMARY_PREFIX}\n\n${decision.output}`;
				result.finalOutput = labeled;
				result.displayItems.push({ type: "text", text: labeled });
				break;
			}
			// decision.action === "nudge". Re-check abort here: it can fire after
			// decideResume() read signal.aborted but before this prompt starts, and
			// the {once:true} listener would have already been consumed.
			if (signal?.aborted) break;
			nudges++;
			result.displayItems.push({
				type: "text",
				text: `↻ resuming after compaction (nudge ${nudges}/${MAX_RESUME_NUDGES})…`,
			});
			lastCompaction = undefined;
			// Clear so readFinalState() below reflects only THIS nudge's text.
			result.finalOutput = "";
			armSettle();
			await session.prompt(RESUME_NUDGE_TEXT, { source: "extension" });
			settle!.kick();
			await settle!.done;
			readFinalState();
		}
		syncUsage();

		if (signal?.aborted) {
			result.stopReason = "aborted";
		}

		// Finalize.
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			result.exitCode = 1;
		} else if (result.exitCode === -1) {
			result.exitCode = 0;
		}
	} catch (err) {
		result.exitCode = 1;
		result.errorMessage = err instanceof Error ? err.message : String(err);
		if (signal?.aborted) {
			result.stopReason = "aborted";
		}
	} finally {
		settle?.dispose();
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		try {
			session?.dispose();
		} catch {
			/* best-effort cleanup */
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Parallel execution helper
// ---------------------------------------------------------------------------

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
