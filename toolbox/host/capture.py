import json
import threading
import re
from uuid import uuid4
from urllib.parse import urlsplit, urlunsplit

from .errors import ToolboxError
from .events import now
from .store import encode, page


class Capture:
    def __init__(self, store, events, core):
        self.store, self.events, self.core = store, events, core
        self._temporary = {}
        self._lock = threading.RLock()

    def add_text(self, text):
        if not isinstance(text, str) or len(text) > 100000:
            raise ToolboxError('INVALID_PARAMETERS', '请粘贴不超过十万字的分享文本。')
        try:
            urls, rejected = self.core.extract_input_urls(text)
        except ValueError as exc:
            raise ToolboxError('INVALID_PARAMETERS', str(exc)) from exc
        items = [{'sourceKey': 'public:' + url, 'sourceKind': 'public', 'sourcePage': 'douyin',
                  'title': '抖音分享视频', 'publicUrl': url, 'linkKind': 'public_page', 'locator': {}} for url in urls]
        return {**self.ingest({'items': items}), 'rejectedCount': len(rejected)}

    def ingest(self, result):
        items = result.get('items')
        if type(items) is not list or len(items) > 200:
            raise ToolboxError('WORKER_PROTOCOL_ERROR', '本页读取结果过大或格式无效。')
        added, updated = 0, 0
        temporary = {}
        with self._lock:
            with self.store.transaction() as db:
                for item in items:
                    if type(item) is not dict:
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '读取条目格式无效。')
                    source_key = item.get('sourceKey')
                    if not isinstance(source_key, str) or not source_key or len(source_key) > 1000:
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '读取条目缺少稳定身份，请重新读取。')
                    if item.get('sourceKind') not in {'public', 'compass_ranking'}:
                        raise ToolboxError('UNSUPPORTED_OPERATION', '此页面来源尚未通过验证。')
                    source_page = str(item.get('sourcePage', ''))
                    if item['sourceKind'] == 'compass_ranking':
                        if '://' in source_key:
                            raise ToolboxError('WORKER_PROTOCOL_ERROR', '页面条目身份不能包含媒体地址。')
                        if source_page != 'compass_ranking':
                            parsed = urlsplit(source_page)
                            if parsed.scheme != 'https' or parsed.hostname != 'compass.jinritemai.com' or parsed.username or parsed.password:
                                raise ToolboxError('WORKER_PROTOCOL_ERROR', '读取页面来源无效。')
                            source_page = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))
                    locator = item.get('locator', {})
                    # locators contain identity fields only; media addresses stay in memory.
                    if type(locator) is not dict or any(k not in {'pageId', 'productId', 'productKey', 'videoId', 'videoKey', 'category', 'rankingType', 'cardKey'} for k in locator):
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '页面定位信息格式无效。')
                    if any(not isinstance(v, (str, int)) or '://' in str(v) for v in locator.values()):
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '定位信息包含不允许保存的内容。')
                    public_url = item.get('publicUrl')
                    if public_url and (not isinstance(public_url, str) or not self.core._is_douyin_host(public_url)):
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '公开链接来源无效。')
                    if public_url:
                        parsed = urlsplit(public_url)
                        if parsed.scheme not in {'http', 'https'} or parsed.username or parsed.password or parsed.path.startswith('/aweme/'):
                            raise ToolboxError('WORKER_PROTOCOL_ERROR', '公开链接必须是分享页面，不能是临时媒体地址。')
                        if item['sourceKind'] == 'compass_ranking':
                            if not re.fullmatch(r'/video/\d+/?', parsed.path):
                                raise ToolboxError('WORKER_PROTOCOL_ERROR', '罗盘公开链接不是可识别的视频页面。')
                            public_url = 'https://www.douyin.com' + parsed.path.rstrip('/')
                    old = db.execute('SELECT id FROM capture_items WHERE source_key=?', (source_key,)).fetchone()
                    item_id = old[0] if old else uuid4().hex
                    provider_id = item.get('providerId')
                    if provider_id is not None and (not isinstance(provider_id, (str, int)) or '://' in str(provider_id)):
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '视频身份格式无效。')
                    values = (item_id, source_key, item['sourceKind'], source_page[:200],
                              item.get('providerId'), str(item.get('title', '视频'))[:2000], public_url,
                              'public_page' if public_url else 'temporary_media' if item.get('mediaUrl') else 'unavailable', encode(locator), now())
                    db.execute('INSERT OR REPLACE INTO capture_items VALUES(?,?,?,?,?,?,?,?,?,?)', values)
                    if item.get('mediaUrl'):
                        temporary[item_id] = item['mediaUrl']
                    else:
                        temporary[item_id] = None
                    if old:
                        updated += 1
                    else:
                        added += 1
            # Publish ephemeral addresses only after the full batch commits.
            for item_id, address in temporary.items():
                if address:
                    self._temporary[item_id] = address
                else:
                    self._temporary.pop(item_id, None)
        self.events.emit('capture.updated', {'added': added, 'updated': updated})
        return {'added': added, 'updated': updated, 'scope': result.get('scope', '当前已加载内容')}

    def list(self, offset=0, limit=50):
        page(offset, limit, 200)
        with self.store._lock:
            total = self.store._db.execute('SELECT count(*) FROM capture_items').fetchone()[0]
            rows = self.store._db.execute('SELECT * FROM capture_items ORDER BY captured_at DESC,id LIMIT ? OFFSET ?', (limit, offset)).fetchall()
            return {'items': [self._item(row) for row in rows], 'total': total}

    def _item(self, row):
        return {'id': row['id'], 'sourceKey': row['source_key'], 'sourceKind': row['source_kind'],
                'sourcePage': row['source_page'], 'providerId': row['provider_id'], 'title': row['title'],
                'publicUrl': row['public_url'], 'linkKind': row['link_kind'], 'locator': json.loads(row['locator_json']),
                'capturedAt': row['captured_at'], 'temporaryAvailable': row['id'] in self._temporary}

    def selected(self, item_ids):
        if type(item_ids) is not list or not item_ids or len(item_ids) > 200 or any(not isinstance(i, str) for i in item_ids):
            raise ToolboxError('INVALID_PARAMETERS', '请选择一到二百条视频。')
        result = []
        with self.store._lock:
            for item_id in dict.fromkeys(item_ids):
                row = self.store._db.execute('SELECT * FROM capture_items WHERE id=?', (item_id,)).fetchone()
                if row is None:
                    raise ToolboxError('INVALID_PARAMETERS', '条目已删除，请刷新列表。')
                result.append(self._item(row))
        return result

    def remove(self, item_ids):
        items = self.selected(item_ids)
        with self._lock, self.store.transaction() as db:
            for item in items:
                db.execute('DELETE FROM capture_items WHERE id=?', (item['id'],))
                self._temporary.pop(item['id'], None)
        self.events.emit('capture.updated', {'removed': len(items)})
        return {'removed': len(items)}

    def copy_text(self, item_ids, field):
        if field not in {'title', 'publicUrl', 'temporaryUrl'}:
            raise ToolboxError('INVALID_PARAMETERS', '复制字段无效。')
        items = self.selected(item_ids)
        values = [self._temporary.get(i['id']) if field == 'temporaryUrl' else i.get(field) for i in items]
        return '\n'.join(str(value) for value in values if value), sum(not value for value in values)
