/**
 * Shared mode/model resolution utilities.
 *
 * Used by handoff and subagent to resolve -mode and -model parameters
 * against modes.json.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/**
 * Load a mode spec from modes.json by name.
 * Checks project-level .pi/modes.json first, then global ~/.pi/agent/modes.json.
 * Returns the spec if found, or undefined.
 */
export async function loadModeSpec(
	cwd: string,
	modeName: string,
): Promise<ModeSpec | undefined> {
	const expandUser = (p: string) => {
		if (p === "~") return os.homedir();
		if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
		return p;
	};

	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandUser(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".pi", "agent");

	const candidates = [
		path.join(cwd, ".pi", "modes.json"),
		path.join(agentDir, "modes.json"),
	];

	for (const modesPath of candidates) {
		try {
			const raw = fs.readFileSync(modesPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.modes && typeof parsed.modes === "object" && parsed.modes[modeName]) {
				const spec = parsed.modes[modeName];
				return {
					provider: typeof spec.provider === "string" ? spec.provider : undefined,
					modelId: typeof spec.modelId === "string" ? spec.modelId : undefined,
					thinkingLevel: typeof spec.thinkingLevel === "string" ? spec.thinkingLevel : undefined,
				};
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ResolvedModeAndThinking {
	model: any;
	thinkingLevel: string;
	/**
	 * The requested overrides that actually took effect. Callers surface these in
	 * the UI: an unknown mode / unavailable model silently falls back to the
	 * parent's model, so echoing the raw request would be a lie.
	 */
	applied: { mode?: string; model?: string };
	/** Requested overrides that could not be resolved and were ignored. */
	unresolved: string[];
}

/**
 * Resolve a target model and thinking level from mode/model parameters.
 * Returns the resolved model and thinking level, using defaults from the
 * current context if not overridden, plus which overrides applied (see
 * ResolvedModeAndThinking) so callers can report honestly.
 */
export async function resolveModelAndThinking(
	cwd: string,
	modelRegistry: any,
	currentModel: any,
	currentThinkingLevel: string,
	params: { mode?: string; model?: string },
): Promise<ResolvedModeAndThinking> {
	let targetModel = currentModel;
	let targetThinkingLevel = currentThinkingLevel;
	const applied: { mode?: string; model?: string } = {};
	const unresolved: string[] = [];

	if (params.mode) {
		const spec = await loadModeSpec(cwd, params.mode);
		// A mode applies all-or-nothing: if it names a model that doesn't resolve,
		// the whole mode is unresolved. Applying just its thinking level would run
		// the parent's model while reporting the mode as applied.
		const m = spec?.provider && spec.modelId
			? modelRegistry.find(spec.provider, spec.modelId)
			: undefined;
		const modelOk = !(spec?.provider && spec.modelId) || !!m;
		if (spec && modelOk && (m || spec.thinkingLevel)) {
			if (m) targetModel = m;
			if (spec.thinkingLevel) targetThinkingLevel = spec.thinkingLevel;
			applied.mode = params.mode;
		} else {
			unresolved.push(`mode:${params.mode}`);
		}
	}

	if (params.model) {
		// Accept pi's CLI form "provider/id:<thinking>" (only a known thinking
		// level is treated as a suffix; model ids may contain colons themselves).
		const colonIdx = params.model.lastIndexOf(":");
		const suffix = colonIdx > 0 ? params.model.slice(colonIdx + 1) : "";
		const thinking = THINKING_LEVELS.includes(suffix) ? suffix : undefined;
		const spec = thinking ? params.model.slice(0, colonIdx) : params.model;
		const slashIdx = spec.indexOf("/");
		const m = slashIdx > 0
			? modelRegistry.find(spec.slice(0, slashIdx), spec.slice(slashIdx + 1))
			: undefined;
		if (m) {
			targetModel = m;
			if (thinking) targetThinkingLevel = thinking;
			applied.model = params.model;
		} else {
			unresolved.push(`model:${params.model}`);
		}
	}

	return { model: targetModel, thinkingLevel: targetThinkingLevel, applied, unresolved };
}
