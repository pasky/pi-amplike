# pi-amplike

[Pi](https://github.com/badlogic/pi-mono) skills and extensions that give Pi similar capabilities to [Amp Code](https://ampcode.com/) out of the box.

<p align="center">
<img src="demo.gif" alt="Pi subagents and /btw in action" width="700" />
</p>

## Features

### Session Management
- **Handoff** - Create a new focused session with AI-generated context transfer:
  - **`/handoff <goal>`** command - Manually create a handoff session (potentially with `-mode <name>` / `-model <name>` parameter to switch models for the new session)
  - **`handoff` tool** - The agent can invoke this (with optional `mode`/`model` parameters) when you explicitly request a handoff
- **`session_query`** tool - The agent in handed-off sessions automatically gets the ability to query the parent session for context, decisions, or code changes; analysis uses the queried session's own model
- Use `/resume` to switch between and navigate handed-off sessions

### Subagents and BTW
- **`subagent`** tool - The agent can create one or multiple parallel task-focused, non-interactive subagents to save context and speed up work
- **`/btw <prompt>`** command - Same semantics as in Claude Code, basically a user-triggered subagent running and finishing asynchronously and independently on the main agent

### Permissions
- **`/permissions`** command toggles bash command allow/deny permissions, directly read from AmpCode's configuration files.

### Prompt Modes
- **`/mode`** command with interactive mode selector/configuration UI (a mode is a model + thinking + color preset, active mode is shown in prompt editor border)
- **Shortcuts**:
  - **`Ctrl+Shift+S`** - mode selector
  - **`Ctrl+Space`** - cycle modes

### Web Access
- **web-search** - Search the web via Jina Search API
- **visit-webpage** - Extract webpage content as markdown (using Jina API), or download images

### Amp Skill Compatibility
- Auto-loads Amp skill directories when present:
  - `~/.config/agents/skills`
  - `~/.config/amp/skills`
  - `.agents/skills` (project-local)

## Installation

### Option A: Install from npm (recommended)

```bash
pi install npm:pi-amplike
```

### Option B: Install from git

```bash
pi install https://github.com/pasky/pi-amplike
```

### Option C: Local development

```bash
git clone https://github.com/pasky/pi-amplike ~/.pi/packages/pi-amplike
cd ~/.pi/packages/pi-amplike
npm install
```

Then add `"packages/pi-amplike"` to the `"packages"` array in `~/.pi/agent/settings.json`.

## Setup

Get a Jina API key for web skills (optional, works with rate limits without it):

```bash
export JINA_API_KEY="your-key"  # Add to ~/.profile or ~/.zprofile
```

Get an API key at [jina.ai](https://jina.ai/). Even if you charge only the minimum credit, it's going to last approximately forever.

## Usage

### Session Handoff

When your conversation gets long or you want to branch off to a focused task, you can use handoff in two ways:

**Manual handoff via command:**
```
/handoff now implement this for teams as well
/handoff -mode rush execute phase one of the plan
/handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
```

Optional flags (can be combined):
- `-mode <name>` — start the new session in a named mode (e.g. `rush`, `smart`, `deep`)
- `-model <provider/id>` — start the new session with a specific model (e.g. `anthropic/claude-haiku-4-5`)

Without these flags, `/handoff` keeps the current model and thinking level in the new session.

The handoff summary is always generated with the *current* session's model before switching.

**Agent-invoked handoff:**
The agent can also initiate a handoff when you explicitly ask for it:
```
"Please hand this off to a new session to implement the fix"
"Create a handoff session to execute phase one"
```

The `handoff` tool also accepts optional `mode` and `model` parameters.

Both methods create a new session with:
- AI-generated summary of relevant context from the current conversation
- List of relevant files that were discussed or modified
- Clear task description based on your goal
- Reference to parent session (accessible via `session_query` tool)

#### Session Navigation

Use Pi's built-in `/resume` command to switch between sessions, including handed-off sessions. The handoff creates sessions with descriptive names that make them easy to find.

#### Querying Past Sessions

The `session_query` tool lets the model look up information from previous sessions. It's automatically used when a handoff includes parent session reference, but can also be invoked directly. The analysis call uses the queried session's own model (falling back to the current model if unavailable):

```
session_query("/path/to/session.jsonl", "What files were modified?")
session_query("/path/to/session.jsonl", "What approach was chosen?")
```


### Subagents

Ask your agent to "use subagents to ..." whenever you know you have a context-hungry task ahead that you would like to run isolated from the main context window.

When your agent is working on something and you suddenly got a question, use `/btw` to ask it. Of course, you can even ask multiple questions in parallel. The `/btw` subagent is ephemeral like tool subagents, but unlike tool subagents it sees the full contxt of your session (besides the fact that it can also use tools to read files).

### Permissions

The permissions extension enforces Amp-style bash command permissions automatically. Use the `/permissions` command to toggle modes:

```
/permissions    # toggles between enabled and yolo
```

- **enabled** (default): Amp permission rules from `~/.config/amp/settings.json` are enforced
- **yolo**: All bash commands are allowed without any checks; `YOLO mode` shown in status bar

The selected mode is persisted in `~/.pi/agent/amplike.json` and restored on the next pi invocation.

### Prompt Modes

```text
/mode              # mode picker
/mode configure    # open mode configuration UI
/mode <name>       # switch directly
/mode store <name> # store current model+thinking into a mode
```

Notes:
- The extension bootstraps with default modes are `rush`, `smart`, and `deep`; they somewhat mirror Amp defaults.
- Modes config is loaded from `.pi/modes.json` (project), falling back to `~/.pi/agent/modes.json` (global).
- Deleting all modes or setting `"modes": {}` in your modes file disables mode overlay behavior (shortcuts + editor mode border), while keeping `/mode` config UI available.

### Web Search

```bash
~/.pi/packages/pi-amplike/skills/web-search/search.py "python async tutorial"
```

### Visit Webpage

```bash
~/.pi/packages/pi-amplike/skills/visit-webpage/visit.py https://docs.example.com/api
```

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [amp-skills](extensions/amp-skills.ts) | Extension | Adds Amp-compatible skill discovery paths (`~/.config/agents/skills`, `~/.config/amp/skills`, `.agents/skills`) |
| [permissions](extensions/permissions.ts) | Extension | Reads `amp.commands.allowlist` and `amp.permissions` from `~/.config/amp/settings.json` (and `.agents/settings.json`) and intercepts bash tool calls accordingly; `/permissions` toggles between `enabled` and `yolo` (all commands allowed, status bar indicator, persisted in `~/.pi/agent/amplike.json`) |
| [handoff](extensions/handoff.ts) | Extension | `/handoff [-mode <name>] [-model <provider/id>] <goal>` command + `handoff` tool (with `mode`/`model` params) for AI-powered context transfer |
| [modes](extensions/modes.ts) | Extension | Prompt mode manager with model/thinking/color presets, editor border overlay, and shortcuts |
| [session-query](extensions/session-query.ts) | Extension | `session_query` tool for querying parent sessions; uses the queried session's own model for analysis |
| [session-query](skills/session-query/) | Skill | Instructions for using the session_query tool |
| [web-search](skills/web-search/) | Skill | Web search via Jina API |
| [visit-webpage](skills/visit-webpage/) | Skill | Webpage content extraction |

## Why "AmpCode-like"?

Amp Code has excellent session management built-in - you can branch conversations, reference parent context, and navigate session history. This package brings similar workflows to Pi:

- **Context handoff** → Amp's conversation branching
- **Session querying** → Amp's ability to reference parent context

## Web Skills Origin

The web-search and visit-webpage skills were extracted from [pasky/muaddib](https://github.com/pasky/muaddib). The original implementations have additional features (rate limiting, multiple backends, async execution) that aren't needed for Pi's skill system.

## License

MIT
