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
const { inheritedPromptLoaderOptions } = await jiti.import("../extensions/lib/subagent-core.ts");

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

// Nothing to inherit -> empty options, i.e. pi's normal prompt discovery. This is
// also the pre-first-turn case, so inheriting is never worse than not inheriting.
eq("undefined -> pi's own discovery", inheritedPromptLoaderOptions(undefined), {});
eq("empty string -> pi's own discovery", inheritedPromptLoaderOptions(""), {});
eq("whitespace only -> pi's own discovery", inheritedPromptLoaderOptions("  \n\t "), {});

// Inheriting: the prompt is passed verbatim...
eq("prompt is inherited as the custom prompt", inheritedPromptLoaderOptions("PARENT PROMPT").systemPrompt, "PARENT PROMPT");
eq("prompt is trimmed", inheritedPromptLoaderOptions("\n PARENT PROMPT \n").systemPrompt, "PARENT PROMPT");

// ...and the sections it already contains must not be appended a second time.
eq("project context not re-appended", inheritedPromptLoaderOptions("x").noContextFiles, true);
eq("skills not re-appended", inheritedPromptLoaderOptions("x").noSkills, true);

console.log(failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
