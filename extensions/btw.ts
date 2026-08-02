/**
 * /btw command — run a subagent in the background while continuing to work.
 *
 * Usage:
 *   /btw check if there are any TODO comments in src/
 *   /btw -mode rush summarize the README
 *   /btw -model anthropic/claude-haiku-4-5 count lines of code
 *
 * Fires off an in-process subagent (same infra as the subagent tool) and
 * shows live progress in a widget above the editor. When finished, the
 * widget is replaced by a fully rendered custom message in the chat
 * (identical to the subagent tool's result rendering).
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { resolveModelAndThinking } from "./lib/mode-utils.js";
import {
	type SingleResult,
	TASK_DISPLAY_LINES_EXPANDED,
	clampTaskForDisplay,
	formatAgentBadge,
	formatToolCall,
	formatUsage,
	btwTaskPreview,
	renderProgressPlainLines,
	runSubagent,
} from "./lib/subagent-core.js";

// ---------------------------------------------------------------------------
// Custom message type
// ---------------------------------------------------------------------------

const BTW_MESSAGE_TYPE = "btw-result";

interface BtwMessageDetails {
	task: string;
	result: SingleResult;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

let btwCounter = 0;

export default function (pi: ExtensionAPI) {
	// Track btw widgets waiting for turn_end to remove themselves
	const pendingWidgetRemovals = new Map<string, () => void>();

	pi.on("turn_end", () => {
		// Resolve all pending widget removal promises — the steered custom
		// messages render at turn boundary, so widgets can now be removed.
		for (const [, resolve] of pendingWidgetRemovals) resolve();
		pendingWidgetRemovals.clear();
	});

	// --- Filter btw messages out of LLM context (user-facing only) ---
	pi.on("context", (event) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === BTW_MESSAGE_TYPE),
		);
		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
	});

	// --- Shared rendering logic for btw results ---
	function renderBtwResult(r: SingleResult, theme: any): InstanceType<typeof Box> {
		const icon = r.exitCode === 0
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");

		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));

		// Single merged header: ✓ btw: [mode/model] <task>
		const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";
		box.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("btw: "))}${badge}${theme.fg("dim", clampTaskForDisplay(r.task, TASK_DISPLAY_LINES_EXPANDED))}`,
				0, 0,
			),
		);

		if (r.exitCode > 0 && r.errorMessage) {
			box.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		}

		// Tool calls
		for (const item of r.displayItems) {
			if (item.type === "toolCall") {
				box.addChild(new Text(
					theme.fg("muted", "→ ") +
						formatToolCall(item.name, item.args, theme.fg.bind(theme)),
					0, 0,
				));
			}
		}

		// Markdown output
		if (r.finalOutput) {
			const mdTheme = getMarkdownTheme();
			box.addChild(new Spacer(1));
			box.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
		}

		// Usage
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) box.addChild(new Text(theme.fg("dim", usageStr), 0, 0));

		return box;
	}

	// --- Custom message renderer: always shows full markdown output ---
	pi.registerMessageRenderer<BtwMessageDetails>(BTW_MESSAGE_TYPE, (message, _opts, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;
		return renderBtwResult(details.result, theme);
	});

	// --- /btw command ---
	pi.registerCommand("btw", {
		description: "Run a single-shot subagent in the background (-mode <name>, -model <provider/id>)",
		handler: async (args, ctx) => {
			// Parse optional -mode and -model flags
			let remaining = args;
			let modeOpt: string | undefined;
			let modelOpt: string | undefined;

			const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
			if (modeMatch) {
				modeOpt = modeMatch[1];
				remaining = remaining.replace(modeMatch[0], " ");
			}

			const modelMatch = remaining.match(/(?:^|\s)-model\s+(\S+)/);
			if (modelMatch) {
				modelOpt = modelMatch[1];
				remaining = remaining.replace(modelMatch[0], " ");
			}

			const task = remaining.trim();
			if (!task) {
				ctx.ui.notify("Usage: /btw [-mode <name>] [-model <provider/id>] <prompt>", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}

			// Resolve model/thinking
			const { model: targetModel, thinkingLevel, applied, unresolved } = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode: modeOpt, model: modelOpt },
			);

			if (!targetModel) {
				ctx.ui.notify("No model available.", "error");
				return;
			}

			// Serialize current conversation context for the subagent
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);
			const conversationContext = messages.length > 0
				? serializeConversation(convertToLlm(messages))
				: "";

			// Build enriched task with conversation context
			const taskWithContext = conversationContext
				? `## Conversation Context\n\n${conversationContext}\n\n## Task or question (FOCUS SOLELY ON THIS)\n\n${task}`
				: task;

			// Unique widget key per invocation so multiple /btw's don't clobber each other
			const widgetKey = `btw-${++btwCounter}`;

			// Badge reflects the overrides that actually applied (see subagent.ts).
			const agentBadge = formatAgentBadge({ ...applied, unresolved });

			// Show initial status widget
			const taskPreview = btwTaskPreview(task);
			ctx.ui.setWidget(
				widgetKey,
				[`⏳ btw: ${agentBadge ? `[${agentBadge}] ` : ""}${taskPreview}`],
				{ placement: "aboveEditor" },
			);

			// Fire and forget — run in background, update widget on progress
			runSubagent({
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				model: targetModel,
				thinkingLevel,
				task: taskWithContext,
				agentBadge,
				parentSessionFile: ctx.sessionManager?.getSessionFile(),
				// Subagents load no extensions, so they'd otherwise miss any
				// extension-driven prompt customization this session runs with.
				inheritSystemPrompt: ctx.getSystemPrompt(),
				// no abort signal — runs to completion
				onProgress: (progressResult) => {
					// Update widget with live tool call feed
					ctx.ui.setWidget(widgetKey, renderProgressPlainLines(task, progressResult), { placement: "aboveEditor" });
				},
			}).then(async (result) => {
				// Override result.task with the short user prompt (not the context-enriched one)
				result.task = task;

				// Send fully rendered result as a custom message in the chat.
				// Filtered out of LLM context by the context event handler above.
				// triggerTurn: false is critical — without it, sendMessage mid-stream
				// tries to start a new turn which corrupts conversation state.
				const icon = result.exitCode === 0 ? "✓" : "✗";
				pi.sendMessage({
					customType: BTW_MESSAGE_TYPE,
					content: [{ type: "text", text: `[btw ${icon}] ${task}` }],
					display: true,
					details: { task, result } satisfies BtwMessageDetails,
				}, { triggerTurn: false });

				// If the agent is busy (tool call running), the custom message won't
				// render in chat until the turn ends.  Show the full rendered result
				// as a component widget so it appears immediately; remove once idle.
				if (!ctx.isIdle()) {
					ctx.ui.setWidget(widgetKey, (_tui, theme) => renderBtwResult(result, theme), { placement: "aboveEditor" });
					// Wait for current turn to end — the steered custom message
					// renders at that point, so we can remove the widget.
					await new Promise<void>((resolve) => {
						pendingWidgetRemovals.set(widgetKey, resolve);
					});
				}
				ctx.ui.setWidget(widgetKey, undefined);
			}).catch((err) => {
				ctx.ui.setWidget(widgetKey, undefined);
				ctx.ui.notify(`btw failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});

			// Command returns immediately — subagent runs in background
		},
	});
}
