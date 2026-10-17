/**
 * Regression tests for the pure display helpers used by the subagent/btw UI:
 * clampTaskForDisplay (anti-flicker input clamp) and formatAgentBadge (the
 * mode/model badge), plus resolveModelAndThinking's applied/unresolved report
 * that the badge is built from.
 *
 * Run: node test/display-format.test.mjs   (also wired into npm test)
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { clampTaskForDisplay, formatAgentBadge, TASK_DISPLAY_LINES } = await jiti.import(
	"../extensions/lib/subagent-core.ts",
);
const { resolveModelAndThinking } = await jiti.import("../extensions/lib/mode-utils.ts");

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

// --- clampTaskForDisplay ---------------------------------------------------
eq("clamp: short task untouched", clampTaskForDisplay("a\nb\nc", 5), "a\nb\nc");
eq("clamp: exactly at limit untouched", clampTaskForDisplay("a\nb\nc", 3), "a\nb\nc");
eq(
	"clamp: marker counts against the budget (total lines <= maxLines)",
	clampTaskForDisplay("1\n2\n3\n4\n5", 3).split("\n").length,
	3,
);
eq("clamp: reports the true omitted count", clampTaskForDisplay("1\n2\n3\n4\n5", 3), "1\n2\n… +3 more lines");
eq("clamp: trailing blank lines dropped, not reported as omitted", clampTaskForDisplay("a\nb\n\n\n", 3), "a\nb");
eq("clamp: degenerate maxLines still keeps one content line", clampTaskForDisplay("1\n2\n3", 1), "1\n… +2 more lines");
eq(
	"clamp: default budget is TASK_DISPLAY_LINES total lines",
	clampTaskForDisplay(Array.from({ length: 100 }, (_, i) => i).join("\n")).split("\n").length,
	TASK_DISPLAY_LINES,
);

// --- formatAgentBadge ------------------------------------------------------
eq("badge: nothing requested -> undefined", formatAgentBadge({}), undefined);
eq("badge: blank strings -> undefined", formatAgentBadge({ mode: "  ", model: "" }), undefined);
eq("badge: mode only", formatAgentBadge({ mode: "deep" }), "deep");
eq("badge: model only", formatAgentBadge({ model: "anthropic/claude-haiku-4-5" }), "anthropic/claude-haiku-4-5");
eq("badge: both", formatAgentBadge({ mode: "deep", model: "a/b" }), "deep a/b");
eq("badge: newlines flattened", formatAgentBadge({ mode: "de\nep" }), "de ep");
eq("badge: overlong part truncated", formatAgentBadge({ model: "x".repeat(100) }).length, 40);

// --- resolveModelAndThinking: applied / unresolved reporting ---------------
const model = (provider, id) => ({ provider, id });
const registry = {
	find: (provider, id) => (provider === "anthropic" && id === "good" ? model(provider, id) : undefined),
};
const parent = model("parent", "parent-model");

const r1 = await resolveModelAndThinking("/nonexistent-cwd", registry, parent, "off", {
	model: "anthropic/good",
});
eq("resolve: known model applies", [r1.model.id, r1.applied, r1.unresolved], ["good", { model: "anthropic/good" }, []]);

const r2 = await resolveModelAndThinking("/nonexistent-cwd", registry, parent, "off", {
	model: "bogus/missing",
});
eq(
	"resolve: unknown model falls back to parent AND is reported unresolved",
	[r2.model.id, r2.applied, r2.unresolved],
	["parent-model", {}, ["model:bogus/missing"]],
);

const r3 = await resolveModelAndThinking("/nonexistent-cwd", registry, parent, "off", {
	model: "no-slash",
});
eq("resolve: malformed model spec reported unresolved", [r3.model.id, r3.unresolved], ["parent-model", ["model:no-slash"]]);

// A mode is looked up in modes.json; with a cwd that has none and no global
// match, it must NOT be claimed as applied.
const r4 = await resolveModelAndThinking("/nonexistent-cwd", registry, parent, "off", {
	mode: "definitely-not-a-real-mode-xyz",
});
eq(
	"resolve: unknown mode reported unresolved",
	[r4.applied, r4.unresolved],
	[{}, ["mode:definitely-not-a-real-mode-xyz"]],
);

// A mode whose model doesn't resolve must not count as applied just because
// its thinking level did (that ran the parent model under the mode's badge).
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const modesCwd = fs.mkdtempSync(path.join(os.tmpdir(), "modes-test-"));
fs.mkdirSync(path.join(modesCwd, ".pi"));
fs.writeFileSync(path.join(modesCwd, ".pi", "modes.json"), JSON.stringify({ modes: {
	gone: { provider: "bogus", modelId: "missing", thinkingLevel: "high" },
	ok: { provider: "anthropic", modelId: "good", thinkingLevel: "high" },
	half: { modelId: "good", thinkingLevel: "high" },
	thinkonly: { thinkingLevel: "high" },
} }));
const r5 = await resolveModelAndThinking(modesCwd, registry, parent, "off", { mode: "gone" });
eq(
	"resolve: mode with unresolvable model is unresolved, nothing half-applied",
	[r5.model.id, r5.thinkingLevel, r5.applied, r5.unresolved],
	["parent-model", "off", {}, ["mode:gone"]],
);
const r6 = await resolveModelAndThinking(modesCwd, registry, parent, "off", { mode: "ok" });
eq("resolve: valid mode applies model + thinking", [r6.model.id, r6.thinkingLevel, r6.applied], ["good", "high", { mode: "ok" }]);
const r7 = await resolveModelAndThinking(modesCwd, registry, parent, "off", { mode: "half" });
eq(
	"resolve: mode with half a provider/modelId pair is unresolved",
	[r7.model.id, r7.thinkingLevel, r7.unresolved],
	["parent-model", "off", ["mode:half"]],
);
const r8 = await resolveModelAndThinking(modesCwd, registry, parent, "off", { mode: "thinkonly" });
eq("resolve: thinking-only mode applies", [r8.model.id, r8.thinkingLevel, r8.applied], ["parent-model", "high", { mode: "thinkonly" }]);
fs.rmSync(modesCwd, { recursive: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
