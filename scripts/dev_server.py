#!/usr/bin/env python3
"""Local preview of site/ with caching disabled: python scripts/dev_server.py [port]"""

import functools
import http.server
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[1] / "site"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".py": "text/plain; charset=utf-8"}

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCacheHandler, directory=str(SITE))
    print(f"img2threejs Studio: http://localhost:{port}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
