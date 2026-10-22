from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4
import json
from .capture import IMAGE_DOMAINS


class StaticServer:
    def __init__(self, directory):
        token = uuid4().hex
        image_sources = ' '.join(f'https://{domain} https://*.{domain}' for domain in IMAGE_DOMAINS)
        assets = {f'/{token}/{name}': ((directory / name).read_bytes(), mime) for name, mime in (
            ('index.html', 'text/html; charset=utf-8'), ('app.js', 'text/javascript; charset=utf-8'),
            ('style.css', 'text/css; charset=utf-8'), ('icon.png', 'image/png'))}
        if (directory / 'cost').is_dir():
            for name, mime in (('app.js', 'text/javascript; charset=utf-8'),
                    ('refresh_model.js', 'text/javascript; charset=utf-8'),
                    ('shipping_filters.js', 'text/javascript; charset=utf-8'), ('styles.css', 'text/css; charset=utf-8')):
                assets[f'/{token}/cost/{name}'] = ((directory / 'cost' / name).read_bytes(), mime)
            template = (directory / 'cost/index.html').read_text(encoding='utf-8')
            assets[f'/{token}/cost/template.js'] = (
                ('globalThis.ToolboxCostTemplate = ' + json.dumps(template, ensure_ascii=False) + ';').encode('utf-8'),
                'text/javascript; charset=utf-8')
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
                self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: " + image_sources + "; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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
