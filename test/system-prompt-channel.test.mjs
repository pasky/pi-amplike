/**
 * Regression test for the subagent system-prompt negotiation channel.
 *
 * Subagents run with no extensions loaded, so extensions that reshape the system
 * prompt (e.g. a per-provider prompt) never fire for them. Instead of guessing,
 * amplike ASKS over pi's cross-extension event bus and uses whatever comes back;
 * it stays ignorant of what any listener does. This test pins that contract:
 * pass-through without listeners, mutation, request fields, and containment of a
 * misbehaving listener/bus.
 *
 * Run: node test/system-prompt-channel.test.mjs   (also wired into npm test)
 */

import { EventEmitter } from "node:events";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { SYSTEM_PROMPT_CHANNEL, negotiateSystemPrompt } = await jiti.import(
	"../extensions/lib/subagent-core.ts",
);

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

// Mirrors pi's EventBus: sync emit, handlers wrapped so their errors can't
// escape into the emitter (see core/event-bus.js).
const makeBus = () => {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => emitter.emit(channel, data),
		on: (channel, handler) =>
			emitter.on(channel, (data) => {
				try {
					handler(data);
				} catch {
					/* swallowed, as pi's bus does */
				}
			}),
	};
};

const req = (systemPrompt) => ({
	target: "subagent",
	provider: "openai-codex",
	modelId: "gpt-5",
	cwd: "/tmp",
	systemPrompt,
});

// --- no bus / no listeners -------------------------------------------------
eq("no bus -> prompt unchanged", negotiateSystemPrompt(undefined, req("base")), "base");
eq("no listeners -> prompt unchanged", negotiateSystemPrompt(makeBus(), req("base")), "base");
eq("no listeners -> undefined stays undefined", negotiateSystemPrompt(makeBus(), req(undefined)), undefined);

// --- listener rewrites the prompt ------------------------------------------
{
	const bus = makeBus();
	bus.on(SYSTEM_PROMPT_CHANNEL, (r) => {
		if (r.provider === "openai-codex") r.systemPrompt = "codex head";
	});
	eq("listener replaces the default prompt", negotiateSystemPrompt(bus, req(undefined)), "codex head");
	eq(
		"listener that doesn't match leaves the prompt alone",
		negotiateSystemPrompt(bus, { ...req("base"), provider: "anthropic" }),
		"base",
	);
}

// --- request payload -------------------------------------------------------
{
	const bus = makeBus();
	let seen;
	bus.on(SYSTEM_PROMPT_CHANNEL, (r) => {
		seen = r;
	});
	negotiateSystemPrompt(bus, req("base"));
	eq("listener sees target/provider/model/cwd/prompt", seen, req("base"));
}

// --- chaining --------------------------------------------------------------
{
	const bus = makeBus();
	bus.on(SYSTEM_PROMPT_CHANNEL, (r) => {
		r.systemPrompt = `${r.systemPrompt ?? ""}a`;
	});
	bus.on(SYSTEM_PROMPT_CHANNEL, (r) => {
		r.systemPrompt = `${r.systemPrompt}b`;
	});
	eq("listeners see each other's edits", negotiateSystemPrompt(bus, req("")), "ab");
}

// --- containment -----------------------------------------------------------
{
	const bus = makeBus();
	bus.on(SYSTEM_PROMPT_CHANNEL, () => {
		throw new Error("boom");
	});
	bus.on(SYSTEM_PROMPT_CHANNEL, (r) => {
		r.systemPrompt = "survived";
	});
	eq("a throwing listener doesn't break negotiation", negotiateSystemPrompt(bus, req("base")), "survived");
}

eq(
	"garbage prompt value is ignored",
	negotiateSystemPrompt(
		{
			emit: (_c, data) => {
				data.systemPrompt = 42;
			},
		},
		req("base"),
	),
	"base",
);

eq(
	"throwing bus falls back to the discovered prompt",
	negotiateSystemPrompt(
		{
			emit: () => {
				throw new Error("bus down");
			},
		},
		req("base"),
	),
	"base",
);

// The request must be a copy: mutations must not leak back into the caller's object.
{
	const original = req("base");
	const bus = makeBus();
	bus.on(SYSTEM_PROMPT_CHANNEL, (r) => {
		r.systemPrompt = "mutated";
	});
	negotiateSystemPrompt(bus, original);
	eq("caller's request object is not mutated", original.systemPrompt, "base");
}

console.log(failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
