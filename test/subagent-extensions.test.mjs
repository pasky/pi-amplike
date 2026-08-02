/**
 * Regression test for subagent extension opt-in path resolution.
 *
 * Subagents load no discovered extensions, so anything that configures a session
 * from `before_agent_start` (notably a system prompt picked per model/provider)
 * is inert for them. The user can opt specific extensions in via amplike.json
 * `subagent.extensions`; those run INSIDE the subagent session, so they see the
 * subagent's own model. This test pins how those entries are resolved.
 *
 * Run: node test/subagent-extensions.test.mjs   (also wired into npm test)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { subagentExtensionPaths } = await jiti.import("../extensions/lib/subagent-core.ts");

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

const AGENT_DIR = "/home/u/.pi/agent";
const paths = (extensions) => subagentExtensionPaths({ subagent: { extensions } }, AGENT_DIR);

// --- nothing configured -> no extensions (opt-in, never implicit) ----------
eq("no settings", subagentExtensionPaths(undefined, AGENT_DIR), []);
eq("no subagent section", subagentExtensionPaths({}, AGENT_DIR), []);
eq("empty list", paths([]), []);
eq("non-array is ignored", subagentExtensionPaths({ subagent: { extensions: "x.ts" } }, AGENT_DIR), []);
eq("blank/non-string entries dropped", paths(["", "   ", null, 7]), []);

// --- resolution ------------------------------------------------------------
// Relative to the agent dir, NOT the cwd: a global extension must mean the same
// thing in every project a subagent runs in.
eq("relative resolves against the agent dir", paths(["extensions/foo.ts"]), [`${AGENT_DIR}/extensions/foo.ts`]);
eq("absolute path kept", paths(["/opt/ext/foo.ts"]), ["/opt/ext/foo.ts"]);
eq("~ expanded", paths(["~/ext/foo.ts"]), [join(homedir(), "ext/foo.ts")]);
eq("bare ~ is the home dir", paths(["~"]), [homedir()]);
eq("entries are trimmed", paths(["  extensions/foo.ts  "]), [`${AGENT_DIR}/extensions/foo.ts`]);
eq("order preserved", paths(["b.ts", "a.ts"]), [`${AGENT_DIR}/b.ts`, `${AGENT_DIR}/a.ts`]);

console.log(failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
