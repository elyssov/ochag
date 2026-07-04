import argparse
import http.client
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
WEB = ROOT / "server" / "web"
UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = 7766


class MobileOchagHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def do_GET(self):
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/m")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/api/") or self.path.startswith("/uploads/"):
            self.proxy()
            return
        self.serve_static()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.proxy()
            return
        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Session-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def serve_static(self):
        path = urlsplit(self.path).path
        files = {
            "/m": "mobile.html",
            "/mobile": "mobile.html",
            "/mobile.html": "mobile.html",
            "/mobile.css": "mobile.css",
            "/mobile.js": "mobile.js",
        }
        name = files.get(path)
        if not name:
            self.send_error(404)
            return
        file_path = WEB / name
        try:
            data = file_path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def proxy(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else None
        headers = {}
        for name in ("Authorization", "Content-Type", "X-Session-Token"):
            if name in self.headers:
                headers[name] = self.headers[name]

        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=15)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            data = response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                lower = name.lower()
                if lower in {"connection", "keep-alive", "transfer-encoding", "content-length"}:
                    continue
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            payload = ("proxy error: %s" % exc).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        finally:
            conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7767)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), MobileOchagHandler)
    print("Ochag mobile proxy listening on http://%s:%d/m" % (args.host, args.port))
    server.serve_forever()


if __name__ == "__main__":
    main()
