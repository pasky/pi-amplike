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
eq(
	"badge: unresolved requests flagged as ignored",
	formatAgentBadge({ unresolved: ["model:bogus/missing"] }),
	"⚠ ignored model:bogus/missing",
);
eq(
	"badge: applied + ignored coexist",
	formatAgentBadge({ mode: "deep", unresolved: ["model:bogus/x"] }),
	"deep ⚠ ignored model:bogus/x",
);
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
