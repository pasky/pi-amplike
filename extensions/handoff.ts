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
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

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
 * Core handoff logic. Returns an error string on failure, or undefined on success.
 */
async function performHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	pendingHandoff: { prompt: string; parentSession: string | undefined } | null,
	setPendingHandoff: (v: { prompt: string; parentSession: string | undefined } | null) => void,
	fromTool = false,
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

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const currentSessionFile = ctx.sessionManager.getSessionFile();

	// Generate the handoff prompt with loader UI
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);

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
				ctx.model!,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey, signal: loader.signal },
			);

			if (response.stopReason === "aborted") {
				return null;
			}

			return response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		};

		doGenerate()
			.then(done)
			.catch((err) => {
				console.error("Handoff generation failed:", err);
				done(null);
			});

		return loader;
	});

	if (result === null) {
		return "Handoff cancelled.";
	}

	// Build the final prompt with user's goal first for easy identification
	let finalPrompt = result;
	if (currentSessionFile) {
		finalPrompt = `${goal}\n\n/skill:session-query\n\n**Parent session:** \`${currentSessionFile}\`\n\n${result}`;
	} else {
		finalPrompt = `${goal}\n\n${result}`;
	}

	if (!fromTool && "newSession" in ctx) {
		// Command path: full reset via ctx.newSession()
		const cmdCtx = ctx as ExtensionCommandContext;
		const newSessionResult = await cmdCtx.newSession({ parentSession: currentSessionFile });
		if (newSessionResult.cancelled) return;
		pi.sendUserMessage(finalPrompt);
	} else {
		// Tool path: defer session switch to agent_end handler.
		// We can't call ctx.newSession() from tool context (only ExtensionCommandContext
		// has it). Instead, we store the handoff data and let the agent_end handler
		// perform the session switch after the current agent loop completes.
		// The context event handler ensures the LLM only sees new-session messages.
		setPendingHandoff({ prompt: finalPrompt, parentSession: currentSessionFile });
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Shared state for tool-path handoff coordination between handlers
	let pendingHandoff: { prompt: string; parentSession: string | undefined } | null = null;

	// Timestamp marking when the handoff session switch occurred.
	// Used by the context event handler to filter out pre-handoff messages
	// from agent.state.messages (which aren't cleared by the low-level switch).
	let handoffTimestamp: number | null = null;

	const setPendingHandoff = (v: typeof pendingHandoff) => {
		pendingHandoff = v;
	};

	// --- Event handlers for tool-path handoff ---
	//
	// WHY IS THIS SO COMPLICATED?
	//
	// The /handoff command path is simple: it has ExtensionCommandContext with
	// ctx.newSession() which does a full agent state reset (agent.reset() +
	// UI clear + queue reset + event emission). But the tool path only gets
	// ExtensionContext, which lacks newSession().
	//
	// Simpler approaches don't work:
	// - sendUserMessage("/new") doesn't expand slash commands
	// - There's no public API to programmatically invoke commands from tool context
	// - sessionManager.newSession() only switches the session file; it does NOT
	//   clear agent.state.messages, so the LLM would still see the entire old
	//   conversation
	// - We can't call agent.reset() from tool context either
	//
	// The solution uses three coordinated event handlers:
	//
	// 1. agent_end: Defers the session switch until after the agent loop completes.
	//    This ensures the tool_result is recorded in the old session first, and
	//    avoids concurrent _runLoop instances. Uses sessionManager.newSession()
	//    for the file switch, then setTimeout(() => sendUserMessage()) to start
	//    the new session in the next macrotask.
	//
	// 2. context: Filters pre-handoff messages using a timestamp. Since we can't
	//    call agent.reset(), old messages remain in agent.state.messages, but the
	//    context event's transformContext mechanism lets us control what the LLM
	//    actually sees. This is safe because getContextUsage() uses the last
	//    assistant's actual usage data (correct after the first response), and
	//    auto-compaction checks assistant usage tokens rather than the messages
	//    array length.
	//
	// 3. session_switch: Clears the context filter when a proper session switch
	//    occurs (e.g., /new), since those fully reset agent.state.messages and
	//    our filter would incorrectly hide the new session's messages.

	// After the agent loop ends, perform the deferred session switch.
	// At this point:
	// - The tool_result has been recorded in the OLD session
	// - The agent is idle (isStreaming = false)
	// - We can safely switch sessions and start a new prompt
	pi.on("agent_end", (_event, ctx) => {
		if (!pendingHandoff) return;

		const { prompt, parentSession } = pendingHandoff;
		pendingHandoff = null;

		// Record timestamp BEFORE switching - all old messages have timestamps
		// before this, all new messages will have timestamps after.
		handoffTimestamp = Date.now();

		// Low-level session switch: creates new session file, resets entries.
		// This does NOT clear agent.state.messages (we handle that via context event).
		(ctx.sessionManager as any).newSession({ parentSession });

		// Defer sendUserMessage to the next macrotask to ensure the old agent
		// loop's _runLoop cleanup has fully completed (isStreaming reset,
		// runningPrompt resolved). Without this, we'd have two concurrent
		// _runLoop instances with conflicting state.
		setTimeout(() => {
			pi.sendUserMessage(prompt);
		}, 0);
	});

	// Before each LLM call, filter out pre-handoff messages.
	// After a tool-path handoff, agent.state.messages still contains all old
	// messages (since we can't call agent.reset()). The context event lets us
	// replace what the LLM sees without affecting agent internals.
	//
	// This is safe because:
	// - getContextUsage() uses the last assistant message's usage data, which
	//   will reflect the small new-session context after the first response
	// - Auto-compaction checks the assistant message's usage tokens, not
	//   agent.state.messages, so won't trigger incorrectly
	// - The session file only contains new-session entries (correct for
	//   token/cost display and session persistence)
	pi.on("context", (event) => {
		if (handoffTimestamp === null) return;

		const newMessages = event.messages.filter((m: any) => m.timestamp >= handoffTimestamp);
		if (newMessages.length > 0) {
			return { messages: newMessages };
		}
		// No messages pass the filter - shouldn't happen in normal flow,
		// but don't break things by returning empty messages
	});

	// When a proper session switch occurs (e.g., /new, tree navigation, /switch),
	// agent.state.messages is fully reset by AgentSession.newSession(). Clear our
	// filter so we don't interfere with the properly-reset state.
	pi.on("session_switch", () => {
		handoffTimestamp = null;
	});

	// /handoff command
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const error = await performHandoff(pi, ctx, goal, pendingHandoff, setPendingHandoff);
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
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const error = await performHandoff(pi, ctx, params.goal, pendingHandoff, setPendingHandoff, true);
			return {
				content: [{ type: "text", text: error ?? "Handoff initiated. The session will switch after the current turn completes." }],
			};
		},
	});
}
