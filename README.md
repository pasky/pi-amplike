# pi-amplike

[Pi](https://github.com/badlogic/pi-mono) skills and extensions that give Pi similar capabilities to [Amp Code](https://ampcode.com/) out of the box.

## Features

### Session Management
- **Handoff** - Create a new focused session with AI-generated context transfer:
  - **`/handoff <goal>`** command - Manually create a handoff session
  - **`handoff` tool** - The agent can invoke this when you explicitly request a handoff
- **`session_query`** tool - The agent in handed-off sessions automatically gets the ability to query the parent session for context, decisions, or code changes
- Use `/resume` to switch between and navigate handed-off sessions

### Web Access
- **web-search** - Search the web via Jina Search API
- **visit-webpage** - Extract webpage content as markdown (using Jina API), or download images

## Installation

### Option A: Install from npm (recommended)

```bash
mkdir -p ~/.pi/packages
cd ~/.pi/packages
npm install pi-amplike
```

This creates `~/.pi/packages/node_modules/pi-amplike`. Pi will pick it up as a package automatically.

### Option B: Install from git

```bash
git clone https://github.com/pasky/pi-amplike ~/.pi/packages/pi-amplike
cd ~/.pi/packages/pi-amplike
npm install
```

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
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

**Agent-invoked handoff:**
The agent can also initiate a handoff when you explicitly ask for it:
```
"Please hand this off to a new session to implement the fix"
"Create a handoff session to execute phase one"
```

Both methods create a new session with:
- AI-generated summary of relevant context from the current conversation
- List of relevant files that were discussed or modified
- Clear task description based on your goal
- Reference to parent session (accessible via `session_query` tool)

### Session Navigation

Use Pi's built-in `/resume` command to switch between sessions, including handed-off sessions. The handoff creates sessions with descriptive names that make them easy to find.

### Querying Past Sessions

The `session_query` tool lets the model look up information from previous sessions. It's automatically used when a handoff includes parent session reference, but can also be invoked directly:

```
session_query("/path/to/session.jsonl", "What files were modified?")
session_query("/path/to/session.jsonl", "What approach was chosen?")
```

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
| [handoff](extensions/handoff.ts) | Extension | `/handoff` command + `handoff` tool for AI-powered context transfer |
| [session-query](extensions/session-query.ts) | Extension | `session_query` tool for querying parent sessions |
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
