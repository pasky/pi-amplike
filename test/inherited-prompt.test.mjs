/**
 * Regression test for subagent system-prompt inheritance.
 *
 * Subagents load no extensions, so extension-driven prompt customization
 * (per-provider prompts, personas, appended house style) would not apply to them
 * — they'd run a different prompt than the session that spawned them. Fix: pass
 * the spawning session's effective prompt into the subagent's resource loader as
 * a complete custom prompt, suppressing the sections pi would otherwise append a
 * second time.
 *
 * Run: node test/inherited-prompt.test.mjs   (also wired into npm test)
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { inheritedPromptLoaderOptions, inheritablePrompt } = await jiti.import(
	"../extensions/lib/subagent-core.ts",
);

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

// Nothing to inherit -> empty options, i.e. pi's normal prompt discovery.
eq("undefined -> pi's own discovery", inheritedPromptLoaderOptions(undefined), {});
eq("empty string -> pi's own discovery", inheritedPromptLoaderOptions(""), {});
eq("whitespace only -> pi's own discovery", inheritedPromptLoaderOptions("  \n\t "), {});

// Inheriting: the prompt is passed verbatim...
eq("prompt is inherited as the custom prompt", inheritedPromptLoaderOptions("PARENT PROMPT").systemPrompt, "PARENT PROMPT");
eq("prompt is trimmed", inheritedPromptLoaderOptions("\n PARENT PROMPT \n").systemPrompt, "PARENT PROMPT");

// ...and the sections it already contains must not be appended a second time.
eq("project context not re-appended", inheritedPromptLoaderOptions("x").noContextFiles, true);
eq("skills not re-appended", inheritedPromptLoaderOptions("x").noSkills, true);
eq("APPEND_SYSTEM.md not re-appended", inheritedPromptLoaderOptions("x").appendSystemPrompt, []);

// --- provider gate ---------------------------------------------------------
// A prompt the session runs with may be written for its provider (that's the
// per-provider prompt case), so a subagent explicitly pointed at another
// provider must not inherit it.
const gate = (sessionProvider, targetProvider) =>
	inheritablePrompt({ prompt: "PARENT PROMPT", sessionProvider, targetProvider });

eq("same provider inherits", gate("anthropic", "anthropic"), "PARENT PROMPT");
eq("other provider does not inherit", gate("anthropic", "openai-codex"), undefined);
eq("unknown session provider does not inherit", gate(undefined, "anthropic"), undefined);
eq("unknown target provider does not inherit", gate("anthropic", undefined), undefined);
eq(
	"no prompt stays no prompt",
	inheritablePrompt({ prompt: undefined, sessionProvider: "anthropic", targetProvider: "anthropic" }),
	undefined,
);

console.log(failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
