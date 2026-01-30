/**
 * Sessions Tree Extension - Navigate parent/child session relationships
 *
 * Shows a tree view of sessions linked via parentSession (from handoff/fork).
 * Unlike /resume which shows a flat list, this reveals session lineage.
 *
 * Usage:
 *   /sessions        - Show session tree for current project
 *   /sessions --all  - Show session tree across all projects
 */

import type { ExtensionAPI, SessionInfo, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import {
	Container,
	Input,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as readline from "node:readline";

interface SessionWithParent extends SessionInfo {
	parentSession?: string;
}

interface SessionTreeNode {
	session: SessionWithParent;
	children: SessionTreeNode[];
	depth: number;
}

/**
 * Efficiently read just the header line from a session file to get parentSession
 */
async function getSessionHeader(
	sessionPath: string,
): Promise<{ parentSession?: string } | null> {
	return new Promise((resolve) => {
		const stream = fs.createReadStream(sessionPath, { encoding: "utf8" });
		const rl = readline.createInterface({ input: stream });

		rl.once("line", (line) => {
			rl.close();
			stream.destroy();
			try {
				const header = JSON.parse(line);
				if (header.type === "session") {
					resolve({ parentSession: header.parentSession });
				} else {
					resolve(null);
				}
			} catch {
				resolve(null);
			}
		});

		rl.once("error", () => {
			resolve(null);
		});

		stream.once("error", () => {
			resolve(null);
		});
	});
}

/**
 * Load sessions with their parentSession info
 */
async function loadSessionsWithParents(
	sessions: SessionInfo[],
	onProgress?: (loaded: number, total: number) => void,
): Promise<SessionWithParent[]> {
	const results: SessionWithParent[] = [];
	let loaded = 0;

	for (const session of sessions) {
		const header = await getSessionHeader(session.path);
		results.push({
			...session,
			parentSession: header?.parentSession,
		});
		loaded++;
		onProgress?.(loaded, sessions.length);
	}

	return results;
}

/**
 * Build tree structure from flat session list
 */
function buildSessionTree(sessions: SessionWithParent[]): SessionTreeNode[] {
	// Index sessions by path for quick lookup
	const byPath = new Map<string, SessionWithParent>();
	for (const s of sessions) {
		byPath.set(s.path, s);
	}

	// Find children for each session
	const childrenOf = new Map<string, SessionWithParent[]>();
	const roots: SessionWithParent[] = [];

	for (const session of sessions) {
		if (session.parentSession && byPath.has(session.parentSession)) {
			// Has a parent that exists in our list
			const children = childrenOf.get(session.parentSession) || [];
			children.push(session);
			childrenOf.set(session.parentSession, children);
		} else {
			// Root node (no parent or parent not in list)
			roots.push(session);
		}
	}

	// Sort roots by modified date (newest first)
	roots.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	// Recursively build tree
	function buildNode(session: SessionWithParent, depth: number): SessionTreeNode {
		const children = childrenOf.get(session.path) || [];
		// Sort children by created date (oldest first for chronological order)
		children.sort((a, b) => a.created.getTime() - b.created.getTime());

		return {
			session,
			children: children.map((child) => buildNode(child, depth + 1)),
			depth,
		};
	}

	return roots.map((root) => buildNode(root, 0));
}

/**
 * Flatten tree for display, computing visual prefixes
 */
interface FlatNode {
	session: SessionWithParent;
	depth: number;
	prefix: string; // Visual tree prefix (├── └── etc.)
	isLast: boolean;
	hasChildren: boolean;
}

function flattenTree(roots: SessionTreeNode[]): FlatNode[] {
	const result: FlatNode[] = [];

	function flatten(
		node: SessionTreeNode,
		depth: number,
		parentPrefixes: string[],
		isLast: boolean,
	): void {
		// Build prefix from parent context
		let prefix = "";
		if (depth > 0) {
			// Add inherited vertical lines from ancestors
			for (let i = 0; i < parentPrefixes.length; i++) {
				prefix += parentPrefixes[i];
			}
			// Add connector for this node
			prefix += isLast ? "└─ " : "├─ ";
		}

		result.push({
			session: node.session,
			depth,
			prefix,
			isLast,
			hasChildren: node.children.length > 0,
		});

		// Process children
		const newParentPrefixes = [...parentPrefixes];
		if (depth > 0) {
			// Add vertical line if parent has more siblings after it
			newParentPrefixes.push(isLast ? "   " : "│  ");
		}

		node.children.forEach((child, i) => {
			const childIsLast = i === node.children.length - 1;
			flatten(child, depth + 1, newParentPrefixes, childIsLast);
		});
	}

	roots.forEach((root, i) => {
		flatten(root, 0, [], i === roots.length - 1);
	});

	return result;
}

/**
 * Session tree selector component
 */
class SessionTreeSelector extends Container {
	private flatNodes: FlatNode[] = [];
	private filteredNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private maxVisibleLines: number;
	private searchInput: Input;
	private searchMode = false;
	private showAllProjects: boolean;
	private currentSessionPath?: string;

	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;

	constructor(
		roots: SessionTreeNode[],
		maxVisibleLines: number,
		showAllProjects: boolean,
		currentSessionPath?: string,
	) {
		super();
		this.maxVisibleLines = maxVisibleLines;
		this.showAllProjects = showAllProjects;
		this.currentSessionPath = currentSessionPath;
		this.flatNodes = flattenTree(roots);
		this.filteredNodes = this.flatNodes;
		this.searchInput = new Input();

		// Try to select current session
		if (currentSessionPath) {
			const idx = this.flatNodes.findIndex((n) => n.session.path === currentSessionPath);
			if (idx >= 0) {
				this.selectedIndex = idx;
				this.ensureVisible();
			}
		}
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().toLowerCase().trim();
		if (!query) {
			this.filteredNodes = this.flatNodes;
		} else {
			this.filteredNodes = this.flatNodes.filter((node) => {
				const text = [
					node.session.firstMessage,
					node.session.name,
					node.session.cwd,
					node.session.path,
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();
				return text.includes(query);
			});
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredNodes.length - 1));
		this.scrollOffset = 0;
		this.ensureVisible();
	}

	private ensureVisible(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.maxVisibleLines) {
			this.scrollOffset = this.selectedIndex - this.maxVisibleLines + 1;
		}
	}

	invalidate(): void {
		super.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Header
		const scope = this.showAllProjects ? "all projects" : "current project";
		lines.push(theme.fg("accent", theme.bold(` Session Tree (${scope})`)));
		lines.push("");

		// Search input if active
		if (this.searchMode) {
			const searchLine = theme.fg("muted", " Search: ") + this.searchInput.getValue() + "█";
			lines.push(truncateToWidth(searchLine, width));
			lines.push("");
		}

		// Session list
		if (this.filteredNodes.length === 0) {
			lines.push(theme.fg("warning", "  No sessions found"));
		} else {
			const visibleNodes = this.filteredNodes.slice(
				this.scrollOffset,
				this.scrollOffset + this.maxVisibleLines,
			);

			visibleNodes.forEach((node, i) => {
				const actualIndex = this.scrollOffset + i;
				const isSelected = actualIndex === this.selectedIndex;
				const isCurrent = node.session.path === this.currentSessionPath;

				// Format: [prefix] [indicator] [name/firstMessage] [date] [cwd if all]
				const indicator = isCurrent ? "● " : "  ";
				const dateStr = formatRelativeDate(node.session.modified);

				// Build the display name
				let displayName = node.session.name || node.session.firstMessage || "(empty)";
				displayName = displayName.split("\n")[0]; // First line only

				// Calculate available width
				const prefixWidth = visibleWidth(node.prefix);
				const indicatorWidth = visibleWidth(indicator);
				const dateWidth = dateStr.length + 2; // " [date]"
				const cwdPart = this.showAllProjects ? ` ${shortenPath(node.session.cwd)}` : "";
				const cwdWidth = visibleWidth(cwdPart);

				const availableForName = width - prefixWidth - indicatorWidth - dateWidth - cwdWidth - 2;
				if (availableForName > 10) {
					displayName = truncateToWidth(displayName, availableForName);
				}

				let line = node.prefix + indicator + displayName;

				// Pad and add metadata
				const currentWidth = visibleWidth(line);
				const padding = Math.max(1, width - currentWidth - dateWidth - cwdWidth - 1);
				line += " ".repeat(padding);
				line += theme.fg("dim", dateStr);
				if (cwdPart) {
					line += theme.fg("muted", cwdPart);
				}

				// Apply selection highlighting
				if (isSelected) {
					line = theme.bg("selectedBg", theme.fg("accent", line));
				} else if (isCurrent) {
					line = theme.fg("success", line);
				} else if (node.depth > 0) {
					// Dim children slightly to emphasize tree structure
					line = theme.fg("text", line);
				}

				lines.push(truncateToWidth(line, width));
			});

			// Scroll indicator
			if (this.filteredNodes.length > this.maxVisibleLines) {
				const scrollInfo = ` ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.maxVisibleLines, this.filteredNodes.length)} of ${this.filteredNodes.length}`;
				lines.push(theme.fg("dim", scrollInfo));
			}
		}

		lines.push("");

		// Help
		const helpText = this.searchMode
			? "enter: apply filter • esc: cancel search"
			: "↑↓/jk: navigate • enter: select • /: filter • esc: cancel";
		lines.push(theme.fg("dim", " " + helpText));

		return lines;
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, Key.escape)) {
				this.searchMode = false;
				this.searchInput.setValue("");
				this.applyFilter();
			} else if (matchesKey(data, Key.enter)) {
				this.searchMode = false;
				// Keep filter applied
			} else {
				this.searchInput.handleInput(data);
				this.applyFilter();
			}
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.ensureVisible();
			}
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.selectedIndex < this.filteredNodes.length - 1) {
				this.selectedIndex++;
				this.ensureVisible();
			}
		} else if (matchesKey(data, Key.pageUp)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
			this.ensureVisible();
		} else if (matchesKey(data, Key.pageDown)) {
			this.selectedIndex = Math.min(
				this.filteredNodes.length - 1,
				this.selectedIndex + this.maxVisibleLines,
			);
			this.ensureVisible();
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			this.ensureVisible();
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = this.filteredNodes.length - 1;
			this.ensureVisible();
		} else if (matchesKey(data, Key.enter)) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected) {
				this.onSelect?.(selected.session.path);
			}
		} else if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
		} else if (data === "/") {
			this.searchMode = true;
		}
	}
}

// Formatting helpers
function formatRelativeDate(date: Date): string {
	const now = Date.now();
	const diff = now - date.getTime();

	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;

	return date.toLocaleDateString();
}

function shortenPath(path: string): string {
	// /home/user/projects/foo -> ~/projects/foo
	const home = process.env.HOME || "";
	if (home && path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	return path;
}

// Theme reference (set during render)
let theme: Theme;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sessions", {
		description: "Show session tree with parent/child relationships",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("sessions requires interactive mode", "error");
				return;
			}

			const showAll = args.trim() === "--all";
			const cwd = ctx.sessionManager.getCwd();
			const currentSessionPath = ctx.sessionManager.getSessionFile();

			// Show loading state
			const result = await ctx.ui.custom<string | null>((tui, themeRef, _kb, done) => {
				theme = themeRef;

				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("muted", " Loading sessions..."), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				let selector: SessionTreeSelector | null = null;
				let loadingComplete = false;

				// Load sessions
				const loadSessions = async () => {
					try {
						// First get the basic session list
						const sessions = showAll
							? await SessionManager.listAll()
							: await SessionManager.list(cwd);

						if (sessions.length === 0) {
							done(null);
							ctx.ui.notify("No sessions found", "info");
							return;
						}

						// Then load parent info for each
						const sessionsWithParents = await loadSessionsWithParents(sessions, (loaded, total) => {
							if (!loadingComplete) {
								container.clear();
								container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
								container.addChild(
									new Text(theme.fg("muted", ` Loading sessions... ${loaded}/${total}`), 1, 0),
								);
								container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
								tui.requestRender();
							}
						});

						loadingComplete = true;

						// Build tree
						const roots = buildSessionTree(sessionsWithParents);

						// Create selector
						const maxLines = Math.max(5, Math.floor(tui.terminal.rows * 0.6));
						selector = new SessionTreeSelector(roots, maxLines, showAll, currentSessionPath);
						selector.onSelect = (path) => done(path);
						selector.onCancel = () => done(null);

						// Replace loading with selector
						container.clear();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(selector);
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						tui.requestRender();
					} catch (err) {
						done(null);
						ctx.ui.notify(`Error loading sessions: ${err}`, "error");
					}
				};

				loadSessions();

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (selector) {
							selector.handleInput(data);
							tui.requestRender();
						} else if (matchesKey(data, Key.escape)) {
							done(null);
						}
					},
				};
			});

			if (result && result !== currentSessionPath) {
				// Can't switch sessions directly from extension API
				const filename = result.split("/").pop() || result;
				// Set up /resume in editor for easy access
				ctx.ui.setEditorText("/resume");
				ctx.ui.notify(`Session: ${filename} (press Enter for /resume, then paste to search)`, "info");
			}
		},
	});
}
