/**
 * Amp permissions — pure decision logic.
 *
 * Shared by the interactive `permissions` extension (which adds UI for "ask")
 * and the subagent runner (which gates bash non-interactively, since subagents
 * have no UI to prompt with). Keeping the rules here is the single source of
 * truth so the two paths can never diverge.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PermissionAction = "allow" | "ask" | "deny" | "reject";

export interface AmpPermission {
	tool: string;
	matches?: { cmd?: string | string[] };
	action: PermissionAction;
}

interface AmpSettings {
	"amp.commands.allowlist"?: string[];
	"amp.permissions"?: AmpPermission[];
}

// Built-in amp permission rules (from amp source, as of early 2026)
export const BUILTIN_PERMISSIONS: AmpPermission[] = [
	{ tool: "Bash", action: "ask", matches: { cmd: "*git*push*" } },
	{
		tool: "Bash",
		matches: {
			cmd: [
				"ls", "ls *", "dir", "dir *", "cat *", "head *", "tail *", "less *", "more *",
				"grep *", "egrep *", "fgrep *", "tree", "tree *", "file *", "wc *", "pwd",
				"stat *", "du *", "df *", "ps *", "top", "htop", "echo *", "printenv *", "id",
				"which *", "whereis *", "date", "cal *", "uptime", "free *", "ping *", "dig *",
				"nslookup *", "host *", "netstat *", "ss *", "lsof *", "ifconfig *", "ip *",
				"man *", "info *", "mkdir *", "touch *", "uname *", "whoami",
				"go version", "go env *", "go help *",
				"cargo version", "cargo --version", "cargo help *",
				"rustc --version", "rustc --help", "rustc --explain *",
				"javac --version", "javac -version", "javac -help", "javac --help",
				"dotnet --info", "dotnet --version", "dotnet --help", "dotnet help *",
				"gcc --version", "gcc -v", "gcc --help", "gcc -dumpversion",
				"g++ --version", "g++ -v", "g++ --help", "g++ -dumpversion",
				"clang --version", "clang --help", "clang++ --version", "clang++ --help",
				"python -V", "python --version", "python -h", "python --help",
				"python3 -V", "python3 --version", "python3 -h", "python3 --help",
				"ruby -v", "ruby --version", "ruby -h", "ruby --help",
				"node -v", "node --version", "node -h", "node --help",
				"npm --help", "npm --version", "npm -v", "npm help *",
				"yarn --help", "yarn --version", "yarn -v", "yarn help *",
				"pnpm --help", "pnpm --version", "pnpm -v", "pnpm help *",
				"pytest -h", "pytest --help", "pytest --version",
				"jest --help", "jest --version", "mocha --help", "mocha --version",
				"make --version", "make --help",
				"docker --version", "docker --help", "docker version", "docker help *",
				"git --version", "git --help", "git help *", "git version",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"go test *", "go run *", "go build *", "go vet *", "go fmt *", "go list *",
				"cargo test *", "cargo run *", "cargo build *", "cargo check *", "cargo fmt *", "cargo tree *",
				"make -n *", "make --dry-run *",
				"mvn test *", "mvn verify *", "mvn dependency:tree *",
				"gradle tasks *", "gradle dependencies *", "gradle properties *",
				"dotnet test *", "dotnet list *",
				"python -c *", "ruby -e *", "node -e *",
				"npm list *", "npm ls *", "npm outdated *", "npm test*", "npm run*", "npm view *", "npm info *",
				"yarn list*", "yarn ls *", "yarn info *", "yarn test*", "yarn run *", "yarn why *",
				"pnpm list*", "pnpm ls *", "pnpm outdated *", "pnpm test*", "pnpm run *",
				"pytest --collect-only *", "jest --listTests *", "jest --showConfig *", "mocha --list *",
				"git status*", "git show *", "git diff*", "git grep *", "git branch *", "git tag *",
				"git remote -v *", "git rev-parse --is-inside-work-tree *", "git rev-parse --show-toplevel *",
				"git config --list *", "git log *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"./gradlew *", "./mvnw *", "./build.sh *", "./configure *", "cmake *",
				"./node_modules/.bin/tsc *", "./node_modules/.bin/eslint *",
				"./node_modules/.bin/prettier *", "prettier *",
				"./node_modules/.bin/tailwindcss *", "./node_modules/.bin/tsx *",
				"./node_modules/.bin/vite *", "bun *", "tsx *", "vite *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				".venv/bin/activate *", ".venv/Scripts/activate *",
				"source .venv/bin/activate *", "source venv/bin/activate *",
				"pip list *", "pip show *", "pip check *", "pip freeze *",
				"uv *", "poetry show *", "poetry check *", "pipenv check *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"asdf list *", "asdf current *", "asdf which *",
				"mise list *", "mise current *", "mise which *", "mise use *",
				"rbenv version *", "rbenv versions *", "rbenv which *",
				"nvm list *", "nvm current *", "nvm which *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"./test*", "./run_tests.sh *", "./run_*_tests.sh *", "vitest *",
				"bundle exec rspec *", "bundle exec rubocop *", "rspec *", "rubocop *",
				"swiftlint *", "clippy *", "ruff *", "black *", "isort *",
				"mypy *", "flake8 *", "bandit *", "safety *", "biome check *", "biome format *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"rails server *", "rails s *", "bin/rails server *", "bin/rails s *",
				"flask run *", "django-admin runserver *", "python manage.py runserver *",
				"uvicorn *", "streamlit run *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"bin/rails db:status", "bin/rails db:version",
				"rails db:rollback *", "rails db:status *", "rails db:version *",
				"alembic current *", "alembic history *",
				"bundle exec rails db:status", "bundle exec rails db:version",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"docker ps *", "docker images *", "docker logs *", "docker inspect *",
				"docker info *", "docker stats *", "docker system df *", "docker system info *",
				"podman ps *", "podman images *", "podman logs *", "podman inspect *", "podman info *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"aws --version *", "aws configure list *", "aws sts get-caller-identity *", "aws s3 ls *",
				"gcloud config list *", "gcloud auth list *", "gcloud projects list *",
				"az account list *", "az account show *",
				"kubectl get *", "kubectl describe *", "kubectl logs *", "kubectl version *",
				"helm list *", "helm status *", "helm version *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"swift build *", "swift test *", "zig build *", "zig build test*",
				"kotlinc *", "scalac *", "javac *", "javap *", "clang *", "jar *",
				"sbt *", "gradle *", "bazel build *", "bazel test *", "bazel run *",
				"mix *", "lua *", "ruby *", "php *",
			],
		},
		action: "allow",
	},
	{
		tool: "Bash",
		matches: { cmd: ["mkdir -p *", "chmod +x *", "dos2unix *", "unix2dos *", "ln -s *"] },
		action: "allow",
	},
	{
		tool: "Bash",
		matches: {
			cmd: [
				"for *", "while *", "do *", "done *", "if *", "then *", "else *",
				"elif *", "fi *", "case *", "esac *", "in *", "function *",
				"select *", "until *", "{ *", "} *", "[[ *", "]] *",
			],
		},
		action: "ask",
	},
	{ tool: "Bash", matches: { cmd: "/^find(?!.*(-delete|-exec|-execdir)).*$/" }, action: "allow" },
	{
		tool: "Bash",
		matches: { cmd: "/^(echo|ls|pwd|date|whoami|id|uname)\\s.*[&|;].*\\s*(echo|ls|pwd|date|whoami|id|uname)($|\\s.*)/" },
		action: "allow",
	},
	{
		tool: "Bash",
		matches: { cmd: "/^(cat|grep|head|tail|less|more|find)\\s.*\\|\\s*(grep|head|tail|less|more|wc|sort|uniq)($|\\s.*)/" },
		action: "allow",
	},
	{
		tool: "Bash",
		matches: { cmd: "/^rm\\s+.*(-[rf].*-[rf]|-[rf]{2,}|--recursive.*--force|--force.*--recursive).*$/" },
		action: "ask",
	},
	{ tool: "Bash", matches: { cmd: "/^find.*(-delete|-exec|-execdir).*$/" }, action: "ask" },
	{ tool: "Bash", matches: { cmd: "/^(ls|cat|grep|head|tail|file|stat)\\s+[^/]*$/" }, action: "allow" },
	{
		tool: "Bash",
		matches: { cmd: "/^(?!.*(rm|mv|cp|chmod|chown|sudo|su|dd)\\b).*/dev/(null|zero|stdout|stderr|stdin).*$/" },
		action: "allow",
	},
	// Default: ask for any unmatched Bash command
	{ tool: "Bash", action: "ask" },
];

// Prefix that agents commonly prepend: "cd /some/dir && <actual command>"
export const CD_PREFIX_RE = /^cd[^;&]*?&&\s*/;

export const GLOBAL_SETTINGS = join(homedir(), ".config", "amp", "settings.json");

/**
 * Extension settings file — follows the <agentDir>/<name>.json convention.
 * Honours PI_CODING_AGENT_DIR (pi's supported config-directory override), so a
 * pi run against a non-default agent dir reads the amplike.json that lives there
 * rather than the one in ~/.pi/agent.
 */
export const AMPLIKE_SETTINGS_PATH = join(resolveAgentDir(), "amplike.json");

/** pi's effective agent dir: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent. */
export function resolveAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (!env) return join(homedir(), ".pi", "agent");
	if (env === "~") return homedir();
	if (env.startsWith("~/")) return join(homedir(), env.slice(2));
	return env;
}

export interface AmplikeSettings {
	permissions?: {
		mode?: "enabled" | "yolo";
	};
	subagent?: {
		/**
		 * Extensions to load into subagent sessions, which otherwise run with none
		 * (see subagentExtensionPaths in lib/subagent-core.ts). Same meaning as pi's
		 * `--no-extensions --extension <path>`: nothing is discovered, only these
		 * load. Relative paths resolve against the pi agent dir (~/.pi/agent), so
		 * "extensions/foo.ts" refers to a global extension; `~` is expanded.
		 */
		extensions?: string[];
	};
}

export function loadSettings(paths: string[]): AmpSettings {
	const merged: AmpSettings = {};
	for (const path of paths) {
		try {
			const data = JSON.parse(readFileSync(path, "utf8")) as AmpSettings;
			if (data["amp.commands.allowlist"]) {
				merged["amp.commands.allowlist"] = [
					...(merged["amp.commands.allowlist"] ?? []),
					...data["amp.commands.allowlist"],
				];
			}
			if (data["amp.permissions"]) {
				merged["amp.permissions"] = [
					...(merged["amp.permissions"] ?? []),
					...data["amp.permissions"],
				];
			}
		} catch {
			// File not found or invalid JSON — skip
		}
	}
	return merged;
}

export function getBaseCommand(command: string): string {
	return command.trim().replace(CD_PREFIX_RE, "").trim().split(/\s+/)[0] ?? "";
}

function globToRegex(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function matchesCmd(pattern: string | string[], command: string): boolean {
	if (Array.isArray(pattern)) {
		return pattern.some((p) => matchesCmd(p, command));
	}
	if (pattern === "*") return true;

	// Regex literal: /pattern/ or /pattern/flags
	const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
	if (regexMatch) {
		try {
			return new RegExp(regexMatch[1], regexMatch[2]).test(command);
		} catch {
			return false;
		}
	}

	// Glob: match against full command
	return globToRegex(pattern).test(command);
}

export function ruleAppliesToBash(rule: AmpPermission): boolean {
	// Simple glob check: does this tool pattern match "Bash"?
	if (rule.tool === "Bash") return true;
	if (rule.tool === "*") return true;
	try {
		return globToRegex(rule.tool).test("Bash");
	} catch {
		return false;
	}
}

export function loadAmplikeSettings(): AmplikeSettings {
	try {
		return JSON.parse(readFileSync(AMPLIKE_SETTINGS_PATH, "utf8")) as AmplikeSettings;
	} catch {
		return {};
	}
}

export function saveAmplikeSettings(settings: AmplikeSettings): void {
	const dir = dirname(AMPLIKE_SETTINGS_PATH);
	mkdirSync(dir, { recursive: true });
	const tmp = `${AMPLIKE_SETTINGS_PATH}.tmp.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
	renameSync(tmp, AMPLIKE_SETTINGS_PATH);
}

/** Coerce a possibly-malformed rule action to a known action (default: ask). */
function normalizeAction(action: unknown): PermissionAction {
	return action === "allow" || action === "deny" || action === "reject" || action === "ask"
		? action
		: "ask";
}

/** Resolve a bash command to the first matching amp permission action. */
export function resolveBashAction(command: string, cwd: string): PermissionAction {
	const strippedCommand = command.trim().replace(CD_PREFIX_RE, "").trim();
	const settings = loadSettings([GLOBAL_SETTINGS, resolve(cwd, ".agents", "settings.json")]);
	const allowlist = settings["amp.commands.allowlist"] ?? [];
	const userRules = settings["amp.permissions"] ?? [];
	const baseCmd = getBaseCommand(command);

	const applyRules = (rules: AmpPermission[]): PermissionAction | undefined => {
		for (const rule of rules) {
			if (!ruleAppliesToBash(rule)) continue;
			const cmdPattern = rule.matches?.cmd;
			if (cmdPattern !== undefined && !matchesCmd(cmdPattern, strippedCommand)) continue;
			return normalizeAction(rule.action);
		}
		return undefined;
	};

	// User rules first (take precedence over allowlist + built-ins)
	const userAction = applyRules(userRules);
	if (userAction !== undefined) return userAction;

	// Allowlist: after user rules, before built-ins
	if (allowlist.includes(baseCmd)) return "allow";

	// Built-in rules as final fallback (always ends with a catch-all "ask")
	return applyRules(BUILTIN_PERMISSIONS) ?? "allow";
}
