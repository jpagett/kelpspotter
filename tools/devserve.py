"""Local static server that refuses to be cached.

`python -m http.server` sends Last-Modified and no Cache-Control, so Chrome
applies heuristic freshness and will happily serve a stale js/app.js alongside a
fresh js/config.js. That mismatch is not hypothetical here — it is the same
skew sw.js can produce in production, and while debugging it locally it makes
every test result a coin flip: you cannot tell a real failure from yesterday's
code still running.

Port 8000 by default because that is the only localhost origin listed in the
API's ALLOWED_ORIGINS (see cloudbuild.yaml); anywhere else and the backend's
CORS check drops the app into demo mode.

    python tools/devserve.py . 8000

Note the service worker still caches the shell independently. When testing a
change, unregister it and clear the caches, then NAVIGATE rather than reload —
a reload is controlled by the worker that just installed, so it serves the
snapshot from the previous load and you end up one version behind.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoStore(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    print("serving %s at http://localhost:%d (no-store)" % (root, port))
    ThreadingHTTPServer(("127.0.0.1", port),
                        lambda *a: NoStore(*a, directory=root)).serve_forever()
