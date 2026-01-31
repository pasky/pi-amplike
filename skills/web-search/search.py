#!/usr/bin/env python3
"""Web search using Jina Search API."""

import os
import sys
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

TIMEOUT = 30


def main():
    if len(sys.argv) < 2:
        print("Usage: search.py <query>")
        print()
        print("Searches the web using Jina Search API.")
        print()
        print("Environment:")
        print("  JINA_API_KEY    Optional. Your Jina API key for higher rate limits.")
        print()
        print("Examples:")
        print('  search.py "python async await"')
        print('  search.py "rust ownership tutorial"')
        sys.exit(1)
    
    query = " ".join(sys.argv[1:])
    encoded_query = urllib.parse.quote(query)
    url = f"https://s.jina.ai/?q={encoded_query}"
    
    # Build headers
    headers = {
        "User-Agent": "pi-skill/1.0",
        "X-Respond-With": "no-content",
        "Accept": "text/plain",
    }
    
    api_key = os.environ.get("JINA_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    
    req = urllib.request.Request(url, headers=headers)
    
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            content = response.read().decode("utf-8", errors="replace").strip()
            
            if not content:
                print("No search results found. Try a different query.")
                sys.exit(0)
            
            print("## Search Results")
            print()
            print(content)
            
    except HTTPError as e:
        print(f"Error: HTTP {e.code} - {e.reason}", file=sys.stderr)
        sys.exit(1)
    except URLError as e:
        print(f"Error: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
