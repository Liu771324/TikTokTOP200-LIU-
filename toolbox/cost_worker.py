"""Persistent cost worker. Management travels only over its inherited private pipes."""
import argparse
import base64
import io
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from contextlib import closing

from toolbox.engines.cost.database import connect_database
from toolbox.engines.cost.desktop_app import AssistantService, ServicePaths, configure_logging, probe_health, service_start_lock
from toolbox.engines.cost.locks import create_management_lock
from toolbox.engines.cost.publication import recover_publication
from toolbox.engines.cost.webview_app import BRIDGE_ACTIONS, DesktopBridge
from toolbox.host.paths import DataPaths, atomic_json
from toolbox.python_worker import pipe_stream

MAX_MESSAGE = 1024 * 1024
MAX_RESULT = 16 * 1024 * 1024
PUBLIC_ACTIONS = BRIDGE_ACTIONS - {'choose_file', 'open_logs', 'get_mapping_reviews', 'resolve_mapping_review'}


class CostBridge(DesktopBridge):
    def __init__(self, service, logger, root):
        super().__init__(service, logger)
        self.inputs = DataPaths(root)
        self._attach_window(SimpleNamespace(get_current_url=lambda: 'http://127.0.0.1/worker/index.html'))
        self._trust_current_page()

    def _input(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{32}', token):
            raise ValueError('文件选择已失效，请重新选择文件')
        folder = self.inputs.resolve('inputs/' + token)
        candidates = list(folder.iterdir()) if folder.is_dir() else []
        if len(candidates) != 1:
            raise ValueError('文件选择已失效，请重新选择文件')
        path = self.inputs.resolve('inputs/' + token + '/' + candidates[0].name)
        if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('成本输入文件不存在或超过 16 MB')
        return str(path)

    def _require_path(self, payload, name):
        return self._input(payload.get(name))

    def _action_inspect_cost_source(self, payload):
        payload = dict(payload)
        if payload.get('path') is not None:
            payload['path'] = self._input(payload['path'])
        return super()._action_inspect_cost_source(payload)

    def _action_start_service(self, payload):
        result = super()._action_start_service(payload)
        if result == 'already_running':
            raise RuntimeError('端口由另一成本进程管理，请关闭独立成本助手后重试')
        return result


def initialize(root, port):
    paths = DataPaths(root)
    root = paths.root
    root.mkdir(parents=True, exist_ok=True)
    db = paths.resolve('cost_accounting.sqlite3')
    output = paths.resolve('enabled_product_costs.xlsx')
    # Keep the same port -> database lock ordering as AssistantService.start().
    with service_start_lock(port):
        if port and probe_health(port) is not None:
            raise RuntimeError('成本端口已被另一进程占用，请关闭独立成本助手后重试')
        with create_management_lock(db):
            recover_publication(db, output)
            if not db.is_file() and (paths.resolve('initialized.json').exists() or output.exists() or any(root.glob('*.bak'))):
                raise RuntimeError('成本库缺失，请恢复原数据；不会创建空库代替已有资料')
            with closing(connect_database(db)) as connection:
                if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('成本数据库完整性检查未通过')
            service = AssistantService(ServicePaths(db, output, paths.resolve('logs')), environment='test', port=port)
            logger = configure_logging(service.paths.logs)
            bridge = CostBridge(service, logger, root)
            result = service.start()
            if result != 'started':
                raise RuntimeError('成本端口已由另一进程管理，请关闭独立成本助手后重试')
            if port == 0:
                service.port = service._server.server_port
            atomic_json(paths.resolve('initialized.json'), {'version': 1})
    return service, bridge


def serve(input_pipe, output_pipe, root, port):
    service = None

    def send(message):
        encoded = json.dumps(message, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(encoded) > MAX_MESSAGE:
            raise ValueError('成本通信超过单条大小限制')
        output_pipe.write(encoded + b'\n')
        output_pipe.flush()

    try:
        service, bridge = initialize(root, port)
        send({'type': 'ready', 'port': service.port})
        while line := input_pipe.readline(MAX_MESSAGE + 2):
            if not line.endswith(b'\n') or len(line) > MAX_MESSAGE:
                raise ValueError('成本通信格式无效')
            message = json.loads(line)
            request_id = message.get('id')
            if not isinstance(request_id, str) or not re.fullmatch('[a-f0-9]{32}', request_id):
                raise ValueError('成本请求标识无效')
            action, payload = message.get('action'), message.get('payload', {})
            if action == 'shutdown':
                service.stop()
                send({'type': 'result', 'id': request_id, 'response': {'ok': True, 'result': True}})
                break
            if action not in PUBLIC_ACTIONS or not isinstance(payload, dict):
                response = {'ok': False, 'error': '不支持此成本操作'}
            else:
                response = bridge.invoke(action, payload)
            data = json.dumps(response, ensure_ascii=False, allow_nan=False).encode('utf-8')
            if len(data) > MAX_RESULT:
                data = json.dumps({'ok': False, 'error': '结果超过 16 MB，请缩小查询范围'}).encode()
            for offset in range(0, len(data), 128 * 1024):
                send({'type': 'chunk', 'id': request_id, 'data': base64.b64encode(data[offset:offset + 128 * 1024]).decode('ascii')})
            send({'type': 'end', 'id': request_id})
    except Exception as exc:
        send({'type': 'fatal', 'message': str(exc)})
    finally:
        if service is not None:
            service.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args(sys.argv[2:] if sys.argv[1:2] == ['--cost-service-worker'] else None)
    input_pipe = pipe_stream(sys.stdin, -10, 'rb')
    output_pipe = pipe_stream(sys.stdout, -11, 'wb')
    sys.stderr = io.TextIOWrapper(pipe_stream(sys.stderr, -12, 'wb'), encoding='utf-8', write_through=True)
    sys.stdout = sys.stderr
    serve(input_pipe, output_pipe, args.root, args.port)


if __name__ == '__main__':
    main()
