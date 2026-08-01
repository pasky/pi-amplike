/**
 * Subagent extension - run isolated subagents over a full AgentSession.
 *
 * Each subagent gets its own persisted, in-process AgentSession (see
 * runSubagent in lib/subagent-core.ts) with the four built-in tools and no
 * extensions loaded (for isolation). AgentSession provides context compaction,
 * overflow recovery, and auto-retry. The task text is passed as the sole user
 * message; there is no shared conversation history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { resolveModelAndThinking } from "./lib/mode-utils.js";
import {
	type SingleResult,
	type SubagentDetails,
	emptyUsage,
	formatAgentBadge,
	mapWithConcurrency,
	renderResults,
	runSubagent,
} from "./lib/subagent-core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	tasks: Type.Array(Type.String(), {
		description: "Task prompts for subagents (as many subagents as tasks provided are spawned). A subagent has no conversation history — include all relevant context (file paths, decisions, requirements) and exact task description in this prompt.",
	}),
	mode: Type.Optional(Type.String({ description: "Amplike mode name for the subagent (e.g. 'rush', 'smart', 'deep'), only based on explicit user instructions." })),
	model: Type.Optional(Type.String({ description: "Model for the subagent, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5'), only based on explicit user instructions." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Run isolated subagents with built-in tools (read, write, edit, bash).",
			"Subagents have two benefits - quickly perform parallel tasks, and save space in your context window.",
			"Subagents are suitable for independent, well-defined, context-hungry, short-output subtasks that don't need back-and-forth with the user, such as research or refactoring.",
			"The downside is they are non-interactive for the user and output tokens are expensive; therefore, use them ONLY when explicitly asked or when your verbalized thinking confirms MAJOR benefits in the current situation).",
			"(Example of stupid prompt you should NOT use a subagent for: 'run A B C D and provide all file contents and command outputs')"
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.tasks || params.tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Provide at least one task." }],
					details: { results: [] },
				};
			}

			// --- Resolve model ---
			const { model: targetModel, thinkingLevel: targetThinkingLevel, applied, unresolved } = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode: params.mode, model: params.model },
			);

			if (!targetModel) {
				return {
					content: [{ type: "text", text: "No model available." }],
					details: { results: [] },
				};
			}

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({ results });

			// Built from the overrides that ACTUALLY applied (plus any ignored ones),
			// not the raw request: an unknown mode/model silently falls back to the
			// parent's model, and a badge echoing the request would misreport that.
			const agentBadge = formatAgentBadge({ ...applied, unresolved });

			const allResults: SingleResult[] = params.tasks.map((task) => ({
				task,
				exitCode: -1, // running
				displayItems: [],
				finalOutput: "",
				usage: emptyUsage(),
				agentBadge,
			}));

			// Emit immediately so renderResult is shown from the start (hiding the renderCall block)
			onUpdate?.({
				content: [{ type: "text", text: "(running...)" }],
				details: makeDetails([...allResults]),
			});

			const emitUpdate = () => {
				if (!onUpdate) return;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				const running = allResults.length - done;
				const statusText = allResults.length === 1
					? (allResults[0].finalOutput || "(running...)")
					: `${done}/${allResults.length} done, ${running} running...`;
				onUpdate({
					content: [{ type: "text", text: statusText }],
					details: makeDetails([...allResults]),
				});
			};

			const results = await mapWithConcurrency(params.tasks, MAX_CONCURRENCY, async (task, index) => {
				const result = await runSubagent({
					cwd: ctx.cwd,
					modelRegistry: ctx.modelRegistry,
					model: targetModel!,
					thinkingLevel: targetThinkingLevel,
					task,
					agentBadge,
					parentSessionFile: ctx.sessionManager?.getSessionFile(),
					// Lets other extensions of this session shape the subagent's system
					// prompt (see SYSTEM_PROMPT_CHANNEL in lib/subagent-core.ts).
					events: pi.events,
					signal,
					onProgress: (r) => {
						allResults[index] = r;
						emitUpdate();
					},
				});
				allResults[index] = result;
				emitUpdate();
				return result;
			});

			const successCount = results.filter((r) => r.exitCode === 0).length;
			const failCount = results.length - successCount;
			const summaries = results.map((r) => {
				const icon = r.exitCode === 0 ? "✓" : "✗";
				// Include the session file path so the caller can session_query the
				// subagent's full transcript (session_query needs a path, not an id).
				const sessionRef = r.sessionFile ? `\n(session_query sessionPath: ${r.sessionFile})` : "";
				if (r.exitCode === 0) {
					return `[${icon}] ${r.finalOutput || "(no output)"}${sessionRef}`;
				}
				// On failure, surface the error (and any partial output) to the caller
				// instead of a bare "(no output)".
				const parts = [r.errorMessage, r.finalOutput].filter((s) => s && s.trim());
				return `[${icon}] ${parts.length ? parts.join("\n") : "(no output)"}${sessionRef}`;
			});

			const isError = results.length === 1 ? results[0].exitCode !== 0 : failCount === results.length;
			return {
				content: [{ type: "text", text: `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
				details: makeDetails(results),
				isError,
			};
		},

		// --- Rendering ---

		// renderCall intentionally omitted: we emit an initial onUpdate immediately so
		// renderResult is shown from the very start of execution. This avoids the
		// call block and result block both repeating the task description.

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			return renderResults(details.results, { expanded, label: "subagent" }, theme);
		},
	});
}
