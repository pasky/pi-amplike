/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Provides both:
 * - /handoff command: user types `/handoff <goal>`
 * - handoff tool: agent can call when user explicitly requests a handoff
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff -mode rush execute phase one of the plan
 *   /handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadModeSpec } from "./lib/mode-utils.js";

// Cross-session communication for handoff.
// When ctx.newSession() replaces the session, the old extension instance is
// disposed and a new one is loaded. Selecting the model needs the new
// instance's `pi`, so the old instance passes the parent's model/thinking and
// the handoff options to the new one's session_start handler through a
// process-global symbol (globalThis survives the replacement).
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type HandoffSelection = {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};
const HANDOFF_GLOBAL_KEY = Symbol.for("pi-amplike-handoff-pending");
type PendingHandoffGlobal = { options?: HandoffOptions; restore?: HandoffSelection } | null;
function getPendingHandoffGlobal(): PendingHandoffGlobal {
	return (globalThis as any)[HANDOFF_GLOBAL_KEY] ?? null;
}
function setPendingHandoffGlobal(data: PendingHandoffGlobal) {
	if (data) {
		(globalThis as any)[HANDOFF_GLOBAL_KEY] = data;
	} else {
		delete (globalThis as any)[HANDOFF_GLOBAL_KEY];
	}
}

// Cross-extension coordination flag, true from the moment a handoff is pending
// until the new session has been (re)started and its prompt dispatched. A
// persistent extension that autonomously triggers turns when the agent is idle
// (the advisor) reads this via the same Symbol.for key and stands down for the
// duration, so it doesn't (a) start a turn that races the handoff's deferred
// sendUserMessage, or (b) inject stray advice into the session that is being
// torn down / replaced. The deferred sendUserMessage below also passes
// deliverAs:"followUp" as a belt-and-suspenders guard against any other source
// of a concurrent turn (e.g. a user-invoked /review).
const HANDOFF_IN_PROGRESS_KEY = Symbol.for("pi-amplike-handoff-in-progress");

// Internal command the tool path dispatches after its run ends, to get an
// ExtensionCommandContext (and with it a proper ctx.newSession()).
const RESUME_COMMAND = "handoff-resume";

function setHandoffInProgress(active: boolean): void {
	if (active) {
		(globalThis as any)[HANDOFF_IN_PROGRESS_KEY] = true;
	} else {
		delete (globalThis as any)[HANDOFF_IN_PROGRESS_KEY];
	}
}

const CONTEXT_SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/**
 * Generate a context summary by asking an LLM to distill the conversation
 * into a focused prompt for a new session.
 *
 * @returns The generated summary text, or null if aborted.
 */
async function generateContextSummary(
	model: any,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	messages: AgentMessage[],
	goal: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const conversationText = serializeConversation(convertToLlm(messages));

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: CONTEXT_SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, headers, signal },
	);

	if (response.stopReason === "aborted") {
		return null;
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

type HandoffOptions = {
	mode?: string;
	model?: string;
};

type PendingHandoff = { prompt: string; parentSession: string | undefined; options?: HandoffOptions };

async function restoreHandoffSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	restore: HandoffSelection,
): Promise<void> {
	const model = ctx.modelRegistry.find(restore.provider, restore.modelId);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Handoff: could not restore ${restore.provider}/${restore.modelId}; using current session model`, "warning");
		}
	} else {
		const ok = await pi.setModel(model);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(`Handoff: no API key for ${restore.provider}/${restore.modelId}; using current session model`, "warning");
		}
	}
	pi.setThinkingLevel(restore.thinkingLevel);
}

/**
 * Apply -mode and -model options after a session switch.
 * For -mode, reads mode spec from modes.json and applies model+thinking.
 * For -model, applies the model directly.
 * The modes extension will sync its state from the resulting model_select event.
 */
async function applyHandoffOptions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options?: HandoffOptions,
): Promise<void> {
	if (!options) return;

	if (options.mode) {
		const spec = await loadModeSpec(ctx.cwd, options.mode);
		if (spec) {
			if (spec.provider && spec.modelId) {
				const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
				if (model) {
					await pi.setModel(model);
				} else {
					ctx.hasUI && ctx.ui.notify(`Handoff: mode "${options.mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
				}
			}
			if (spec.thinkingLevel) {
				pi.setThinkingLevel(spec.thinkingLevel as any);
			}
		} else {
			ctx.hasUI && ctx.ui.notify(`Handoff: unknown mode "${options.mode}"`, "warning");
		}
	}

	if (options.model) {
		// Parse "provider/modelId" format
		const slashIdx = options.model.indexOf("/");
		if (slashIdx > 0) {
			const provider = options.model.slice(0, slashIdx);
			const modelId = options.model.slice(slashIdx + 1);
			const model = ctx.modelRegistry.find(provider, modelId);
			if (model) {
				await pi.setModel(model);
			} else {
				ctx.hasUI && ctx.ui.notify(`Handoff: unknown model ${options.model}`, "warning");
			}
		} else {
			ctx.hasUI && ctx.ui.notify(`Handoff: invalid model format "${options.model}", expected provider/modelId`, "warning");
		}
	}
}

/**
 * Core handoff logic. Returns an error string on failure, or undefined on success.
 */
async function performHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	setPendingHandoff: (v: PendingHandoff | null) => void,
	fromTool = false,
	options?: HandoffOptions,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return "Handoff requires interactive mode.";
	}

	if (!ctx.model) {
		return "No model selected.";
	}

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return "No conversation to hand off.";
	}

	const currentSessionFile = ctx.sessionManager.getSessionFile();

	// Generate the handoff prompt with loader UI
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok) return null;
			return generateContextSummary(ctx.model!, auth.apiKey, auth.headers, messages, goal, loader.signal);
		};

		doGenerate()
			.then(done)
			.catch((err) => {
				console.error("Handoff generation failed:", err);
				done(null);
			});

		return loader;
	});

	// ui.custom() yields undefined where custom UI isn't supported (e.g. RPC).
	if (typeof result !== "string") {
		return result === null ? "Handoff cancelled." : "Handoff requires the interactive TUI.";
	}

	// Build the final prompt with user's goal first for easy identification
	let finalPrompt = result;
	if (currentSessionFile) {
		finalPrompt = `${goal}\n\n/skill:session-query\n\n**Parent session:** \`${currentSessionFile}\`\n\n${result}`;
	} else {
		finalPrompt = `${goal}\n\n${result}`;
	}

	const pending = { prompt: finalPrompt, parentSession: currentSessionFile, options };
	if (!fromTool && "newSession" in ctx) {
		await startHandoffSession(pi, ctx as ExtensionCommandContext, pending);
	} else {
		// Tool path: tool context has no newSession(), and the session can't be
		// replaced mid-run anyway. Stash the handoff; the agent_end handler
		// dispatches the internal resume command, whose command context can.
		setPendingHandoff(pending);
		setHandoffInProgress(true);
	}

	return undefined;
}

/**
 * Replace the session with a fresh one and hand it the prompt.
 *
 * Both paths go through the runtime's full session replacement (ctx.newSession()):
 * it rebuilds the agent state from the new session, so the first prompt records a
 * complete system message (prompt sections + tool declarations). The tool path used
 * to switch only the session file underneath the live agent, which left the old
 * transcript in agent state; pi then recorded only the system prompt *changes*
 * relative to it, and since requests are built from the session file, the new
 * session's model got a partial prompt and no tools.
 *
 * After newSession() the runtime tears down this session and creates a new one
 * with fresh extensions; our `pi` reference becomes stale. The new instance's
 * session_start handler applies the model (see PendingHandoffGlobal), and the
 * prompt is sent from withSession, which runs once the replacement session is
 * fully started and bound.
 */
async function startHandoffSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	pending: PendingHandoff,
): Promise<void> {
	const { prompt, parentSession, options } = pending;
	// Always carry the parent's selection over first; -mode/-model then override
	// it (a thinking-only mode or an unknown model must not fall back to the
	// configured default model).
	const restore = ctx.model
		? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: pi.getThinkingLevel() }
		: undefined;
	setPendingHandoffGlobal({ options, restore });
	setHandoffInProgress(true);
	try {
		await ctx.newSession({
			parentSession,
			withSession: async (newCtx) => {
				// Not awaited: that would hold the replacement until the whole run ends.
				// deliverAs:"followUp" queues the prompt if another extension has
				// slipped a turn in, instead of throwing "Agent is already processing".
				newCtx.sendUserMessage(prompt, { deliverAs: "followUp" }).catch((err) => {
					newCtx.ui.notify(`Handoff prompt failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				});
			},
		});
	} finally {
		// Whether replaced, cancelled or failed: nothing is pending any more.
		setPendingHandoffGlobal(null);
		setHandoffInProgress(false);
	}
}

export default function (pi: ExtensionAPI) {
	// Tool-path handoff stashed by the handoff tool until its run ends.
	let pendingHandoff: PendingHandoff | null = null;

	const setPendingHandoff = (v: PendingHandoff | null) => {
		pendingHandoff = v;
	};

	// --- Tool-path handoff ---
	//
	// The tool runs inside the agent loop and only gets an ExtensionContext, which
	// has no newSession(); the live session can't be replaced mid-run anyway. So:
	//
	// 1. The tool stashes the handoff (pendingHandoff).
	// 2. agent_end: once the run is over (the tool result is recorded in the OLD
	//    session), dispatch the internal resume command in the next macrotask.
	//    sendUserMessage with expandPromptTemplates dispatches extension commands
	//    with a full ExtensionCommandContext.
	// 3. The resume command waits for idle and performs the same full session
	//    replacement as the /handoff command (startHandoffSession).
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;

	// Drop a tool-path handoff that will never be resumed, so the advisor isn't
	// left muted by the in-progress flag.
	const abandonPendingHandoff = () => {
		if (resumeTimer !== undefined) clearTimeout(resumeTimer);
		resumeTimer = undefined;
		if (!pendingHandoff) return;
		pendingHandoff = null;
		setHandoffInProgress(false);
	};

	pi.on("agent_end", () => {
		if (!pendingHandoff || resumeTimer !== undefined) return;
		resumeTimer = setTimeout(() => {
			resumeTimer = undefined;
			try {
				pi.sendUserMessage(`/${RESUME_COMMAND}`, { expandPromptTemplates: true });
			} catch {
				// E.g. this instance went stale because the session was replaced or
				// reloaded first.
				abandonPendingHandoff();
			}
		}, 0);
	});

	// Another session replacement, reload or quit beat the resume command. (Our own
	// replacement consumes pendingHandoff before it shuts this session down.)
	pi.on("session_shutdown", () => {
		abandonPendingHandoff();
	});

	pi.registerCommand(RESUME_COMMAND, {
		description: "(internal) Complete a handoff requested by the handoff tool",
		handler: async (_args, ctx) => {
			const pending = pendingHandoff;
			pendingHandoff = null;
			if (!pending) {
				ctx.ui.notify("No pending handoff", "warning");
				return;
			}
			try {
				await ctx.waitForIdle();
				await startHandoffSession(pi, ctx, pending);
			} catch (err) {
				// Never leave the advisor muted by a failed handoff.
				setPendingHandoffGlobal(null);
				setHandoffInProgress(false);
				ctx.ui.notify(`Handoff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// After ctx.newSession() replaces the runtime, this NEW extension instance's
	// session_start fires: select the parent's model, then apply -mode/-model.
	// The prompt itself is sent by the old instance's withSession callback, after
	// the replacement session has fully started.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;
		const pending = getPendingHandoffGlobal();
		if (!pending) return;
		setPendingHandoffGlobal(null);
		if (pending.restore) {
			await restoreHandoffSelection(pi, ctx, pending.restore);
		}
		await applyHandoffOptions(pi, ctx, pending.options);
	});

	// /handoff command
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (-mode <name>, -model <provider/id>)",
		handler: async (args, ctx) => {
			// Parse optional -mode and -model flags from args
			const options: HandoffOptions = {};
			let remaining = args;

			const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
			if (modeMatch) {
				options.mode = modeMatch[1];
				remaining = remaining.replace(modeMatch[0], " ");
			}

			const modelMatch = remaining.match(/(?:^|\s)-model\s+(\S+)/);
			if (modelMatch) {
				options.model = modelMatch[1];
				remaining = remaining.replace(modelMatch[0], " ");
			}

			const goal = remaining.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff [-mode <name>] [-model <provider/id>] <goal>", "error");
				return;
			}

			const hasOptions = options.mode || options.model;
			const error = await performHandoff(pi, ctx, goal, setPendingHandoff, false, hasOptions ? options : undefined);
			if (error) {
				ctx.ui.notify(error, "error");
			}
		},
	});

	// handoff tool (agent-callable)
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. Provide a goal describing what the new session should focus on.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal/task for the new session" }),
			mode: Type.Optional(Type.String({ description: "Amplike mode name to start the new session with (e.g. 'rush', 'smart', 'deep')" })),
			model: Type.Optional(Type.String({ description: "Model to start the new session with, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5')" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options: HandoffOptions = {};
			if (params.mode) options.mode = params.mode;
			if (params.model) options.model = params.model;
			const hasOptions = options.mode || options.model;
			const error = await performHandoff(pi, ctx, params.goal, setPendingHandoff, true, hasOptions ? options : undefined);
			return {
				content: [{ type: "text", text: error ?? "Handoff initiated. The session will switch after the current turn completes." }],
			};
		},

		renderCall(args, theme) {
			const parts: string[] = [];

			// Goal: show first ~5 lines, truncated
			const goal = (args.goal as string) ?? "";
			const goalLines = goal.split("\n");
			const truncatedGoal = goalLines.length > 5
				? goalLines.slice(0, 5).join("\n") + "\n" + theme.fg("dim", `… (${goalLines.length - 5} more lines)`)
				: goal;

			parts.push(theme.fg("toolTitle", theme.bold("Handoff ")));

			if (args.mode) {
				parts.push(theme.fg("accent", `-mode ${args.mode} `));
			}
			if (args.model) {
				parts.push(theme.fg("accent", `-model ${args.model} `));
			}

			parts.push(theme.fg("muted", truncatedGoal));

			return new Text(parts.join(""), 0, 0);
		},
	});
}
