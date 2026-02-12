import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const AMP_GLOBAL_SKILL_DIRS = [
	join(homedir(), ".config", "agents", "skills"),
	join(homedir(), ".config", "amp", "skills"),
];

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", ({ cwd }) => {
		const ampProjectSkillsDir = resolve(cwd, ".agents", "skills");
		const skillPaths = [...AMP_GLOBAL_SKILL_DIRS, ampProjectSkillsDir].filter(isDirectory);
		if (skillPaths.length === 0) return;
		return { skillPaths };
	});
}
