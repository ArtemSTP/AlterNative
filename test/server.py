"""Local stand for excel-viewer.

Serves the SPA and a small JSON-file API over sandbox/json.

Usage:
    python test/server.py [--port 8787]

API:
    GET  /api/tree?path=&recursive=true
    GET  /api/files/<path>
    PUT  /api/files/<path>   {"content": "...", "last_commit_id": "..."}
    POST /api/files/<path>   {"content": "..."}
"""

import argparse
import base64
import hashlib
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

SPA_ROOT = Path(__file__).resolve().parent.parent
JSON_ROOT = SPA_ROOT / "sandbox" / "json"


def is_within(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_json_path(relative: str) -> Path:
    # Нормализуем и не выпускаем за пределы sandbox/json
    target = (JSON_ROOT / relative).resolve()
    if not is_within(JSON_ROOT, target):
        raise PermissionError("path outside sandbox")
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "ExcelViewerLocal/1.0"

    def _cors_origin(self):
        """Разрешаем CORS только локальным страницам."""
        origin = self.headers.get("Origin")
        if not origin:
            return None
        try:
            host = urlparse(origin).hostname
        except ValueError:
            return None
        if host in ("127.0.0.1", "localhost", "::1"):
            return origin
        return None

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, PRIVATE-TOKEN")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _error(self, status: int, message: str):
        self._json(status, {"message": message})

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    # ---------- API ----------

    def _api_tree(self, query):
        rel = (parse_qs(query).get("path") or [""])[0].strip("/")
        try:
            base = safe_json_path(rel) if rel else JSON_ROOT
        except PermissionError:
            return self._error(400, "path outside sandbox")

        if not base.exists() or not base.is_dir():
            return self._error(404, "folder not found")

        items = []
        for root, dirs, files in os.walk(base):
            root_path = Path(root)
            dirs.sort()
            for name in dirs:
                full = root_path / name
                items.append({
                    "name": name,
                    "path": full.relative_to(JSON_ROOT).as_posix(),
                    "type": "tree",
                })
            for name in sorted(files):
                if not name.lower().endswith(".json"):
                    continue
                full = root_path / name
                items.append({
                    "name": name,
                    "path": full.relative_to(JSON_ROOT).as_posix(),
                    "type": "blob",
                })
        self._json(200, items)

    def _api_read(self, rel):
        try:
            path = safe_json_path(rel)
        except PermissionError:
            return self._error(400, "path outside sandbox")

        if not path.is_file():
            return self._error(404, "file not found")

        data = path.read_bytes()
        self._json(200, {
            "file_path": rel,
            "content": base64.b64encode(data).decode("ascii"),
            "last_commit_id": hashlib.sha256(data).hexdigest(),
        })

    def _api_write(self, rel, create: bool):
        try:
            body = self._read_json_body()
        except (ValueError, UnicodeDecodeError):
            return self._error(400, "invalid JSON body")

        content = body.get("content")
        if not isinstance(content, str):
            return self._error(400, "content is required")

        try:
            path = safe_json_path(rel)
        except PermissionError:
            return self._error(400, "path outside sandbox")

        if create:
            if path.exists():
                return self._error(400, "A file with this name already exists")
        else:
            if not path.is_file():
                return self._error(404, "file not found")
            expected = body.get("last_commit_id")
            if expected and expected != file_hash(path):
                return self._error(
                    409,
                    "You are attempting to update a file that has changed "
                    "since you started editing it.",
                )

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        self._json(200, {"file_path": rel})

    # ---------- Static ----------

    def _static(self, url_path):
        rel = unquote(url_path.lstrip("/")) or "index.html"
        target = (SPA_ROOT / rel).resolve()

        if not is_within(SPA_ROOT, target) or not target.is_file():
            return self._error(404, "not found")

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix in (".html", ".js", ".css", ".yaml", ".json", ".svg"):
            content_type += "; charset=utf-8"
        self._send(200, target.read_bytes(), content_type)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            return self._json(200, {"ok": True, "root": str(JSON_ROOT)})
        if path == "/api/tree":
            return self._api_tree(parsed.query)
        if path.startswith("/api/files/"):
            return self._api_read(unquote(path[len("/api/files/"):]))
        if path.startswith("/api/"):
            return self._error(404, "unknown api method")
        self._static(path)

    def do_PUT(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/files/"):
            return self._error(404, "unknown api method")
        self._api_write(unquote(path[len("/api/files/"):]), create=False)

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/files/"):
            return self._error(404, "unknown api method")
        self._api_write(unquote(path[len("/api/files/"):]), create=True)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    JSON_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving {SPA_ROOT}")
    print(f"JSON root {JSON_ROOT}")
    print(f"Open http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
