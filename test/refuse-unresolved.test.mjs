/**
 * subagent / /btw / handoff must refuse to run when an explicitly requested
 * mode or model doesn't resolve — never silently proceed on the parent's model.
 * Every path past the refusal point hits a sentinel that throws.
 *
 * Run: node test/refuse-unresolved.test.mjs   (also wired into npm test)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "@mariozechner/jiti";

// Isolate mode lookup from the user's real modes.json.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "refuse-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.writeFileSync(path.join(agentDir, "modes.json"), JSON.stringify({ modes: {
	gone: { provider: "bogus", modelId: "missing", thinkingLevel: "high" },
} }));

const jiti = createJiti(import.meta.url);
let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
	if (!ok) failures++;
};

function proceeded() { throw new Error("PROCEEDED past the refusal point"); }

async function load(file) {
	const tools = {}, commands = {};
	const pi = new Proxy({
		registerTool: (t) => { tools[t.name] = t; },
		registerCommand: (n, c) => { commands[n] = c; },
		getThinkingLevel: () => "off",
	}, { get: (t, k) => (k in t ? t[k] : () => {}) });
	(await jiti.import(file, { default: true }))(pi);
	return { tools, commands };
}

const notes = [];
const ctx = {
	cwd: agentDir,
	hasUI: true,
	model: { provider: "parent", id: "parent-model" },
	modelRegistry: { find: (p, id) => (p === "anthropic" && id === "good" ? { provider: p, id } : undefined) },
	ui: { notify: (m, level) => notes.push([m, level]), custom: proceeded, setWidget: proceeded },
	sessionManager: { getBranch: proceeded, getSessionFile: () => undefined },
};

const { tools: subTools } = await load("../extensions/subagent.ts");
for (const [name, params] of [
	["unknown mode", { mode: "no-such-mode" }],
	["mode whose model is unavailable", { mode: "gone" }],
	["unknown model", { model: "bogus/x" }],
	["valid model does not rescue an invalid mode", { mode: "no-such-mode", model: "anthropic/good" }],
]) {
	let r, err;
	try { r = await subTools.subagent.execute("id", { tasks: ["t"], ...params }, undefined, proceeded, ctx); } catch (e) { err = e; }
	check(`subagent refuses: ${name}`, !err && r?.isError && /^Not run: could not resolve/.test(r.content[0].text), err?.message ?? JSON.stringify(r));
}

const { commands: btwCmds } = await load("../extensions/btw.ts");
notes.length = 0;
let btwErr;
try { await btwCmds.btw.handler("-mode gone what's up", ctx); } catch (e) { btwErr = e; }
check("/btw refuses: mode whose model is unavailable",
	!btwErr && notes.length === 1 && notes[0][1] === "error" && /isn't available/.test(notes[0][0]),
	btwErr?.message ?? JSON.stringify(notes));

const { tools: hoTools } = await load("../extensions/handoff.ts");
let hr, hoErr;
try { hr = await hoTools.handoff.execute("id", { goal: "g", mode: "no-such-mode" }, undefined, undefined, ctx); } catch (e) { hoErr = e; }
check("handoff refuses: unknown mode", !hoErr && hr?.isError && /^Handoff not started/.test(hr.content[0].text),
	hoErr?.message ?? JSON.stringify(hr));

fs.rmSync(agentDir, { recursive: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
