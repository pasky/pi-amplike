/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and starts a new session with a generated prompt.
 *
 * Provides both:
 * - /handoff command: user types `/handoff <goal>`
 * - handoff tool: agent can call when user explicitly requests a handoff
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff -mode rush execute phase one of the plan
 *   /handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadModeSpec } from "./lib/mode-utils.js";

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

const HANDOFF_STATE_TYPE = "handoff-state";

type HandoffOptions = {
	mode?: string;
	model?: string;
};

type PendingHandoff = {
	prompt: string;
	parentSession: string | undefined;
	options?: HandoffOptions;
};

type PendingHandoffState = {
	kind: "pending";
	token: string;
	prompt: string;
	options?: HandoffOptions;
};

type HandoffState =
	| PendingHandoffState
	| { kind: "dispatched"; token: string }
	| { kind: "submitted"; token: string }
	| { kind: "failed"; token: string; error: string };

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

function createHandoffToken(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isHandoffState(data: unknown): data is HandoffState {
	if (!data || typeof data !== "object") return false;
	const value = data as Partial<HandoffState>;
	return typeof value.kind === "string" && typeof value.token === "string";
}

function getPendingHandoffState(ctx: ExtensionContext): PendingHandoffState | undefined {
	const pending: PendingHandoffState[] = [];
	const handled = new Set<string>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== HANDOFF_STATE_TYPE || !isHandoffState(entry.data)) {
			continue;
		}

		if (entry.data.kind === "pending") {
			pending.push(entry.data);
		} else {
			handled.add(entry.data.token);
		}
	}

	for (let i = pending.length - 1; i >= 0; i -= 1) {
		if (!handled.has(pending[i].token)) {
			return pending[i];
		}
	}

	return undefined;
}

async function startHandoffSession(ctx: ExtensionCommandContext, handoff: PendingHandoff): Promise<boolean> {
	const token = createHandoffToken();
	const newSessionResult = await ctx.newSession({
		parentSession: handoff.parentSession,
		setup: async (sessionManager) => {
			sessionManager.appendCustomEntry(HANDOFF_STATE_TYPE, {
				kind: "pending",
				token,
				prompt: handoff.prompt,
				options: handoff.options,
			});
		},
	});
	return !newSessionResult.cancelled;
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
	queuePendingHandoff: ((handoff: PendingHandoff) => void) | undefined,
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

	if (result === null) {
		return "Handoff cancelled.";
	}

	let finalPrompt = result;
	if (currentSessionFile) {
		finalPrompt = `${goal}\n\n/skill:session-query\n\n**Parent session:** \`${currentSessionFile}\`\n\n${result}`;
	} else {
		finalPrompt = `${goal}\n\n${result}`;
	}

	if (!fromTool && "newSession" in ctx) {
		const cmdCtx = ctx as ExtensionCommandContext;
		const started = await startHandoffSession(cmdCtx, {
			prompt: finalPrompt,
			parentSession: currentSessionFile,
			options,
		});
		if (!started) return;
		return undefined;
	}

	if (!queuePendingHandoff) {
		return "Handoff is unavailable from this context.";
	}

	try {
		queuePendingHandoff({ prompt: finalPrompt, parentSession: currentSessionFile, options });
		return undefined;
	} catch (error) {
		return `Failed to queue handoff: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export default function (pi: ExtensionAPI) {
	const pendingHandoffs = new Map<string, PendingHandoff>();
	let scheduledAutoSubmit: ReturnType<typeof setTimeout> | undefined;

	const clearScheduledAutoSubmit = () => {
		if (scheduledAutoSubmit !== undefined) {
			clearTimeout(scheduledAutoSubmit);
			scheduledAutoSubmit = undefined;
		}
	};

	const queuePendingHandoff = (handoff: PendingHandoff) => {
		const token = createHandoffToken();
		pendingHandoffs.set(token, handoff);
		try {
			pi.sendUserMessage(`/handoff-apply ${token}`, { deliverAs: "followUp" });
		} catch (error) {
			pendingHandoffs.delete(token);
			throw error;
		}
	};

	pi.on("session_shutdown", async () => {
		clearScheduledAutoSubmit();
	});

	pi.on("session_start", async (_event, ctx) => {
		clearScheduledAutoSubmit();
		const pending = getPendingHandoffState(ctx);
		if (!pending) return;

		scheduledAutoSubmit = setTimeout(() => {
			scheduledAutoSubmit = undefined;
			void (async () => {
				try {
					pi.appendEntry(HANDOFF_STATE_TYPE, { kind: "dispatched", token: pending.token });
					await applyHandoffOptions(pi, ctx, pending.options);
					await pi.sendUserMessage(pending.prompt);
					pi.appendEntry(HANDOFF_STATE_TYPE, { kind: "submitted", token: pending.token });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					pi.appendEntry(HANDOFF_STATE_TYPE, { kind: "failed", token: pending.token, error: message });
					if (ctx.hasUI) {
						ctx.ui.setEditorText(pending.prompt);
						ctx.ui.notify(`Handoff auto-submit failed: ${message}. Prompt restored to editor.`, "warning");
					}
				}
			})();
		}, 0);
	});

	pi.registerCommand("handoff-apply", {
		description: "Internal handoff follow-up command",
		handler: async (args, ctx) => {
			const token = args.trim();
			if (!token) {
				ctx.hasUI && ctx.ui.notify("Missing handoff token.", "error");
				return;
			}

			const pending = pendingHandoffs.get(token);
			if (!pending) {
				ctx.hasUI && ctx.ui.notify("Handoff request expired or was already applied.", "warning");
				return;
			}
			pendingHandoffs.delete(token);

			await startHandoffSession(ctx, pending);
		},
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (-mode <name>, -model <provider/id>)",
		handler: async (args, ctx) => {
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
			const error = await performHandoff(pi, ctx, goal, undefined, false, hasOptions ? options : undefined);
			if (error) {
				ctx.ui.notify(error, "error");
			}
		},
	});

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
			const error = await performHandoff(pi, ctx, params.goal, queuePendingHandoff, true, hasOptions ? options : undefined);
			return {
				content: [{ type: "text", text: error ?? "Handoff queued. The session will switch after the current turn completes." }],
				details: {},
			};
		},
	});
}
