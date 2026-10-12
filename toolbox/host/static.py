from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4


class StaticServer:
    def __init__(self, directory):
        token = uuid4().hex
        assets = {f'/{token}/{name}': ((directory / name).read_bytes(), mime) for name, mime in (
            ('index.html', 'text/html; charset=utf-8'), ('app.js', 'text/javascript; charset=utf-8'),
            ('style.css', 'text/css; charset=utf-8'))}
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                item = assets.get(self.path)
                if not item:
                    self.send_error(404)
                    return
                body, mime = item
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}/{token}/index.html'
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
