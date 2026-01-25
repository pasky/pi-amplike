# llmagent-skills

[Pi](https://github.com/badlogic/pi-mono) skills for web search and webpage content extraction, using Jina APIs.

Extracted from [pasky/irssi-llmagent](https://github.com/pasky/irssi-llmagent) agentic tools.

## Skills

| Skill | Description |
|-------|-------------|
| [web-search](web-search/) | Search the web via Jina Search API |
| [visit-webpage](visit-webpage/) | Extract webpage content as markdown, or download images |

## Setup

```bash
export JINA_API_KEY="your-key"  # Add to ~/.profile or ~/.zprofile
```

Get a free API key at [jina.ai](https://jina.ai/).

## Installation

Clone to your pi skills directory:

```bash
git clone https://github.com/pasky/llmagent-skills ~/.pi/agent/skills/llmagent
```

## Differences from irssi-llmagent

The original implementations in irssi-llmagent have additional features:

- **Rate limiting** - Built-in rate limiter class with configurable calls/second
- **Multiple search backends** - Supports Jina, Brave Search API, and DuckDuckGo (ddgs)
- **Async execution** - Full async/await with aiohttp
- **Image content blocks** - Returns base64-encoded images directly in LLM context
- **Artifact store integration** - Direct filesystem access for local artifacts
- **Progress callbacks** - Real-time progress updates during fetching

These skills are simplified standalone versions suitable for pi's skill system.

## License

MIT
