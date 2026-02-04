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
	getMarkdownTheme,
	serializeConversation,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
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
		label: (params) => `Session Query: ${params.question}`,
		description:
			"Query a previous pi session file for context, decisions, or information. Use when you need to look up what happened in a parent session or any other session.",
		renderResult: (result, _options, theme) => {
			const container = new Container();
			
			if (result.content && result.content[0]?.text) {
				const text = result.content[0].text;
				// Parse: **Query:** question\n\n---\n\nanswer
				const match = text.match(/\*\*Query:\*\* (.+?)\n\n---\n\n([\s\S]+)/);
				
				if (match) {
					const [, query, answer] = match;
					container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query), 0, 0));
					container.addChild(new Spacer(1));
					// Render the answer as markdown
					container.addChild(new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("toolOutput", text),
					}));
				} else {
					// Fallback for other formats (errors, etc)
					container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				}
			}
			
			return container;
		},
		parameters: Type.Object({
			sessionPath: Type.String({
				description: "Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
			}),
			question: Type.String({
				description: "What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { sessionPath, question } = params;

			// Helper for error returns
			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			// Validate session path
			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
			}

			// Check if file exists
			try {
				const fs = await import("node:fs");
				if (!fs.existsSync(sessionPath)) {
					return errorResult(`Error: Session file not found: ${sessionPath}`);
				}
			} catch (err) {
				return errorResult(`Error checking session file: ${err}`);
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Query: ${question}`,
					},
				],
				details: { status: "loading", question },
			});

			// Load the session
			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			// Get conversation from the session
			const branch = sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Session is empty - no messages found." }],
					details: { empty: true },
				};
			}

			// Serialize the conversation
			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			// Use LLM to answer the question
			if (!ctx.model) {
				return errorResult("Error: No model available to analyze the session.");
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
						content: [{ type: "text" as const, text: "Query was cancelled." }],
						details: { cancelled: true },
					};
				}

				const answer = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: `**Query:** ${question}\n\n---\n\n${answer}` }],
					details: {
						sessionPath,
						question,
						messageCount: messages.length,
					},
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
