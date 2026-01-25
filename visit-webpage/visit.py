#!/usr/bin/env python3
"""Visit webpage and extract content as markdown, or download images."""

import os
import re
import sys
import tempfile
import time
import urllib.request
from urllib.error import HTTPError, URLError

MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_CONTENT_LENGTH = 100000  # 100KB text limit
TIMEOUT = 60
RETRY_DELAYS = [0, 30, 90]

IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def get_headers(include_jina_auth: bool = False) -> dict[str, str]:
    """Build request headers."""
    headers = {"User-Agent": "pi-skill/1.0"}
    api_key = os.environ.get("JINA_API_KEY")
    if include_jina_auth and api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def check_content_type(url: str) -> str | None:
    """Check URL content type via HEAD request. Returns content-type or None on error."""
    req = urllib.request.Request(url, method="HEAD", headers=get_headers())
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            return response.headers.get("Content-Type", "").lower().split(";")[0]
    except (HTTPError, URLError):
        return None


def download_image(url: str) -> str:
    """Download image and save to temp file. Returns file path."""
    req = urllib.request.Request(url, headers=get_headers())
    
    with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
        content_type = response.headers.get("Content-Type", "").lower().split(";")[0]
        
        if content_type not in IMAGE_EXTENSIONS:
            raise ValueError(f"Unsupported image type: {content_type}")
        
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MAX_IMAGE_SIZE:
            raise ValueError(f"Image too large: {content_length} bytes (max {MAX_IMAGE_SIZE})")
        
        data = response.read()
        if len(data) > MAX_IMAGE_SIZE:
            raise ValueError(f"Image too large: {len(data)} bytes (max {MAX_IMAGE_SIZE})")
        
        ext = IMAGE_EXTENSIONS[content_type]
        
        # Create temp file with appropriate extension
        fd, filepath = tempfile.mkstemp(suffix=ext, prefix="visit-image-")
        os.write(fd, data)
        os.close(fd)
        
        return filepath


def fetch_webpage(url: str) -> str:
    """Fetch webpage content via Jina Reader with retries."""
    jina_url = f"https://r.jina.ai/{url}"
    headers = get_headers(include_jina_auth=True)
    
    last_error = None
    for i, delay in enumerate(RETRY_DELAYS):
        if delay > 0:
            print(f"Waiting {delay}s before retry {i+1}/{len(RETRY_DELAYS)}...", file=sys.stderr)
            time.sleep(delay)
        
        req = urllib.request.Request(jina_url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                content = response.read().decode("utf-8", errors="replace")
                
                # Clean up multiple line breaks
                content = re.sub(r"\n{3,}", "\n\n", content)
                
                # Truncate if too long
                if len(content) > MAX_CONTENT_LENGTH:
                    content = content[:MAX_CONTENT_LENGTH] + "\n\n..._Content truncated_..."
                
                return content
                
        except HTTPError as e:
            last_error = e
            if e.code in (451, 500, 502, 503, 504) and i < len(RETRY_DELAYS) - 1:
                print(f"HTTP {e.code}, will retry...", file=sys.stderr)
                continue
            raise
        except URLError as e:
            last_error = e
            if i < len(RETRY_DELAYS) - 1:
                print(f"Network error: {e.reason}, will retry...", file=sys.stderr)
                continue
            raise
    
    raise last_error or RuntimeError("Failed after retries")


def main():
    if len(sys.argv) < 2:
        print("Usage: visit.py <url>")
        print()
        print("Fetches a webpage and extracts its content as markdown,")
        print("or downloads images to a temp file.")
        print()
        print("Environment:")
        print("  JINA_API_KEY    Optional. Your Jina API key for higher rate limits.")
        print()
        print("Examples:")
        print("  visit.py https://example.com/article")
        print("  visit.py https://example.com/image.png")
        sys.exit(1)
    
    url = sys.argv[1]
    
    # Validate URL
    if not url.startswith(("http://", "https://")):
        print("Error: URL must start with http:// or https://", file=sys.stderr)
        sys.exit(1)
    
    try:
        # Check content type first
        content_type = check_content_type(url)
        
        if content_type and content_type.startswith("image/"):
            # Handle image - download to temp and print path (like browser-screenshot.js)
            filepath = download_image(url)
            print(filepath)
        else:
            # Handle webpage
            content = fetch_webpage(url)
            print(f"## Content from {url}")
            print()
            print(content)
            
    except HTTPError as e:
        print(f"Error: HTTP {e.code} - {e.reason}", file=sys.stderr)
        sys.exit(1)
    except URLError as e:
        print(f"Error: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
