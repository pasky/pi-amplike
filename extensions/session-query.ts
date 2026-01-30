/**
 * Session Query Extension - Query previous pi sessions
 *
 * Provides a tool the model can use to query past sessions for context,
 * decisions, code changes, or other information.
 *
 * Works with handoff: when a handoff prompt includes "Parent session: <path>",
 * the model can use this tool to look up details from that session.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	SessionManager,
	convertToLlm,
	serializeConversation,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Query a previous pi session file for context, decisions, or information. Use when you need to look up what happened in a parent session or any other session.",
		parameters: Type.Object({
			sessionPath: Type.String({
				description: "Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
			}),
			question: Type.String({
				description: "What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
		}),

		async execute(toolCallId, params, onUpdate, ctx, signal) {
			const { sessionPath, question } = params;

			// Validate session path
			if (!sessionPath.endsWith(".jsonl")) {
				return {
					content: [{ type: "text", text: `Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}` }],
					isError: true,
				};
			}

			// Check if file exists
			try {
				const fs = await import("node:fs");
				if (!fs.existsSync(sessionPath)) {
					return {
						content: [{ type: "text", text: `Error: Session file not found: ${sessionPath}` }],
						isError: true,
					};
				}
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error checking session file: ${err}` }],
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Loading session..." }],
			});

			// Load the session
			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error loading session: ${err}` }],
					isError: true,
				};
			}

			// Get conversation from the session
			const branch = sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: "Session is empty - no messages found." }],
				};
			}

			// Serialize the conversation
			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			// Use LLM to answer the question
			onUpdate?.({
				content: [{ type: "text", text: "Analyzing session..." }],
			});

			if (!ctx.model) {
				return {
					content: [{ type: "text", text: "Error: No model available to analyze the session." }],
					isError: true,
				};
			}

			try {
				const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);

				const userMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${question}`,
						},
					],
					timestamp: Date.now(),
				};

				const response = await complete(
					ctx.model,
					{ systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey, signal },
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text", text: "Query was cancelled." }],
					};
				}

				const answer = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text", text: answer }],
					details: {
						sessionPath,
						question,
						messageCount: messages.length,
					},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error querying session: ${err}` }],
					isError: true,
				};
			}
		},
	});
}
