"""
Tile Server
===========
Minimal read-only HTTP server for the coverage tiles (PMTiles), started once
in a background thread. PMTiles are read by the browser with HTTP Range
requests; Streamlit's own static serving refuses files over 200 MB, and the
national coverage file is bigger.

Only files directly inside the served folder are reachable, only on
127.0.0.1. In the web version this is replaced by the real web server / CDN.
"""

import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

_RANGE = re.compile(r"bytes=(\d*)-(\d*)$")
SERVED_SUFFIXES = {".pmtiles", ".json"}
CHUNK = 256 * 1024


def _handler_for(root: Path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):          # keep the Streamlit console clean
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Range")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _target(self):
            name = unquote(urlparse(self.path).path).lstrip("/")
            # a single file name inside root, nothing else
            if (not name or "/" in name or "\\" in name or name.startswith(".")
                    or Path(name).suffix.lower() not in SERVED_SUFFIXES):
                return None
            p = root / name
            return p if p.is_file() else None

        def do_HEAD(self):
            self.do_GET(head=True)

        def do_GET(self, head=False):
            p = self._target()
            if p is None:
                self.send_error(404)
                return
            size = p.stat().st_size
            start, end = 0, size - 1
            m = _RANGE.match(self.headers.get("Range", "").strip())
            if m and (m[1] or m[2]):
                if m[1]:
                    start = int(m[1])
                    end = min(int(m[2]), size - 1) if m[2] else size - 1
                else:                            # suffix range: last N bytes
                    start = max(size - int(m[2]), 0)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self._cors()
                    self.end_headers()
                    return
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            length = end - start + 1
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", f'"{int(p.stat().st_mtime)}-{size}"')
            self.send_header("Cache-Control", "max-age=3600")
            self._cors()
            self.end_headers()
            if head:
                return
            with open(p, "rb") as f:
                f.seek(start)
                while length > 0:
                    block = f.read(min(CHUNK, length))
                    if not block:
                        break
                    try:
                        self.wfile.write(block)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    length -= len(block)

    return Handler


def start_tile_server(root, host: str = "127.0.0.1", port: int = 0) -> str:
    """Serve root in a daemon thread; returns the base URL (a free port is picked)."""
    server = ThreadingHTTPServer((host, port), _handler_for(Path(root).resolve()))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="verea-tiles", daemon=True).start()
    return f"http://{host}:{server.server_address[1]}"
