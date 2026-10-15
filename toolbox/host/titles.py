"""Native input selection and one-use approval for the product-title writer."""
import hashlib
import json
import re
import threading
import time
from pathlib import Path
from uuid import uuid4

from .errors import ToolboxError
from .paths import atomic_json, display_filename

MAX_INPUT = 25 * 1024 * 1024
MAX_PLAN = 20 * 1024 * 1024
IDENTIFIER = re.compile(r'^[a-f0-9]{32}$')


class Titles:
    def __init__(self, app):
        self.app = app
        self._lock = threading.RLock()
        self._inputs = {}
        self._plans = {}

    def choose_input(self):
        import webview
        with self._lock, self.app.scheduler._lock, self.app.operations._lock:
            selected = self.app.window.create_file_dialog(webview.FileDialog.OPEN,
                allow_multiple=False, file_types=('标题表格 (*.xlsx;*.xls)',))
            if not selected:
                return {'cancelled': True}
            source = Path(selected[0])
            if source.suffix.lower() not in {'.xls', '.xlsx'} or not source.is_file():
                raise ToolboxError('INVALID_PARAMETERS', '请选择 .xls 或 .xlsx 标题表格。')
            with source.open('rb') as stream:
                data = stream.read(MAX_INPUT + 1)
            if not data or len(data) > MAX_INPUT:
                raise ToolboxError('INVALID_PARAMETERS', '标题表格必须非空且不超过 25 MB。')
            input_id = uuid4().hex
            directory = self.app.store.paths.resolve('scratch/title-import-' + input_id)
            directory.mkdir()
            target = directory / display_filename(source.stem, source.suffix.lower())
            target.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            context = {'protocolVersion': 1, 'toolId': 'product-title', 'operationId': input_id,
                'dataRoot': str(self.app.store.paths.root), 'scratchRoot': str(directory), 'browser': None}
            result = self.app.operations._call('title_input', {'inputPath': str(target), 'inputSha256': digest}, context)
            self._inputs.clear()
            self._plans.clear()
            self._inputs[input_id] = {'inputPath': str(target), 'inputSha256': digest}
            return {**result, 'inputId': input_id, 'fileName': source.name, 'cancelled': False}

    def preview(self, input_id, shops, product_status):
        with self._lock:
            source = self._inputs.get(input_id) if isinstance(input_id, str) else None
            if not source:
                raise ToolboxError('INVALID_PARAMETERS', '请重新选择标题表格。')
            if (type(shops) is not list or not 1 <= len(shops) <= 500
                    or any(type(shop) is not dict or set(shop) != {'id', 'name'}
                           or not isinstance(shop['id'], str) or not re.fullmatch(r'\d{1,40}', shop['id'])
                           or not isinstance(shop['name'], str) or not 1 <= len(shop['name']) <= 200 for shop in shops)
                    or len({shop['id'] for shop in shops}) != len(shops)
                    or type(product_status) is not dict or set(product_status) != {'value', 'label'}
                    or any(not isinstance(value, str) or len(value) > 200 for value in product_status.values())):
                raise ToolboxError('INVALID_PARAMETERS', '请选择有效的店铺和商品状态。')
            self._plans.clear()
            return self.app.operations.submit('title_plan', 'product-title',
                {**source, 'shops': shops, 'productStatus': product_status})

    def receive_plan(self, result, context):
        with self._lock, self.app.store._files_lock:
            expected = self.app.store.paths.resolve('scratch/operation-' + context['operationId'] + '/plan.json')
            if type(result) is not dict or result.get('planPath') != str(expected):
                raise ToolboxError('WORKER_PROTOCOL_ERROR', '标题预览文件位置无效。')
            plan, _ = self._load(expected)
            self._validate(plan)
            plan_id, token = uuid4().hex, uuid4().hex
            destination = self.app.store.paths.resolve('scratch/title-plan-' + plan_id + '/plan.json')
            atomic_json(destination, plan)
            self._plans[token] = {'id': plan_id, 'path': destination,
                'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'expires': time.monotonic() + 600}
            # Old previews cannot accumulate unbounded memory or approvals.
            self._plans = {key: value for key, value in self._plans.items() if value['expires'] > time.monotonic()}
            while len(self._plans) > 10:
                self._plans.pop(next(iter(self._plans)))
            return {'token': token, 'summary': plan['summary'], 'expiresInSeconds': 600}

    @staticmethod
    def _load(path):
        try:
            with path.open('rb') as stream:
                data = stream.read(MAX_PLAN + 1)
            if len(data) > MAX_PLAN:
                raise ValueError('oversize')
            value = json.loads(data)
            if type(value) is not dict:
                raise ValueError('invalid plan')
            return value, hashlib.sha256(data).hexdigest()
        except (OSError, ValueError) as error:
            raise ToolboxError('INVALID_PARAMETERS', '标题预览已失效或无法读取，请重新预览。') from error

    @staticmethod
    def _validate(plan):
        items = plan.get('items')
        if (plan.get('engine') != 'product-title-v1' or type(items) is not list or len(items) > 10000
                or type(plan.get('summary')) is not dict or type(plan.get('groups')) is not list
                or not 1 <= len(plan['groups']) <= 100 or type(plan.get('shops')) is not list
                or type(plan.get('productStatus')) is not dict):
            raise ToolboxError('INVALID_PARAMETERS', '标题预览格式无效，请重新预览。')
        keys = set()
        shop_ids = {shop['id'] for shop in plan['shops'] if type(shop) is dict and isinstance(shop.get('id'), str)}
        for item in items:
            if (type(item) is not dict or not isinstance(item.get('id'), str)
                    or not re.fullmatch(r'\d{1,40}', item['id']) or item.get('shopId') not in shop_ids
                    or any(not isinstance(item.get(key), str) or len(item[key]) > 4000
                           for key in ('before', 'target', 'original', 'shopName'))):
                raise ToolboxError('INVALID_PARAMETERS', '标题预览商品记录无效。')
            key = (item['shopId'], item['id'])
            if key in keys:
                raise ToolboxError('INVALID_PARAMETERS', '多个原标题命中同一商品，请调整查询词后重新预览。')
            keys.add(key)
        summary = plan['summary']
        if (summary.get('productCount') != len(items)
                or summary.get('changeCount') != sum(bool(item['target']) and item['target'] != item['before'] for item in items)):
            raise ToolboxError('INVALID_PARAMETERS', '标题预览数量不一致，请重新预览。')

    def _approved_plan(self, token):
        record = self._plans.get(token) if isinstance(token, str) else None
        if not record or record['expires'] <= time.monotonic():
            raise ToolboxError('INVALID_PARAMETERS', '预览已过期或已使用，请重新预览商品修改。')
        path = self.app.store.paths.resolve(self.app.store.paths.relative(record['path']))
        plan, digest = self._load(path)
        if digest != record['sha256']:
            raise ToolboxError('INVALID_PARAMETERS', '预览内容已变化，请重新预览商品修改。')
        self._validate(plan)
        return record, plan

    def plan_page(self, token, offset=0, limit=50):
        from .store import page
        page(offset, limit, 100)
        with self._lock:
            _, plan = self._approved_plan(token)
            return {'items': [dict(item, productId=item['id']) for item in plan['items'][offset:offset + limit]],
                'total': len(plan['items'])}

    def create(self, token):
        with self._lock:
            record, plan = self._approved_plan(token)
            summary = plan['summary']
            if not summary['changeCount']:
                raise ToolboxError('INVALID_PARAMETERS', '没有需要修改的商品，请检查表格和查询范围。')
            names = '、'.join(shop['name'] for shop in plan['shops'])
            confirmed = self.app.window.create_confirmation_dialog('确认修改商品标题',
                f"店铺：{names}\n商品状态：{plan['productStatus']['label']}\n"
                f"将按预览修改 {summary['changeCount']} 件商品的标题。成功保存无法自动回滚；"
                '停止只阻止后续提交，当前提交会先核对结果。确定开始？')
            if not confirmed:
                return {'cancelled': True}
            record, _ = self._approved_plan(token)
            with self.app.scheduler._lock, self.app.operations._lock:
                task = self.app.scheduler.create('product-title', {'planId': record['id'], 'planSha256': record['sha256']})
                self._plans.pop(token)
            return {'taskId': task['id'], 'cancelled': False}
