from .errors import ToolboxError
from .files import clipboard

FIELDS = {
    'app.get_state': set(), 'app.show': set(), 'app.request_exit': set(), 'events.read': {'afterSeq', 'limit'},
    'browser.get_state': set(), 'browser.open': {'source'}, 'browser.list_pages': set(), 'browser.clear_login': {'confirmed'},
    'tools.discover': {'toolId'}, 'tasks.create': {'toolId', 'parameters', 'itemIds'},
    'tasks.list': {'toolId', 'state', 'offset', 'limit'}, 'tasks.get': {'taskId'},
    'tasks.control': {'taskId', 'command'}, 'tasks.results': {'taskId', 'offset', 'limit', 'section'},
    'tasks.artifacts': {'taskId', 'offset', 'limit'},
    'tasks.logs': {'taskId', 'afterSeq', 'limit'}, 'capture.read_page': {'pageId'}, 'capture.add_text': {'text'},
    'capture.list': {'offset', 'limit'}, 'capture.remove': {'itemIds'}, 'capture.copy': {'itemIds', 'field'},
    'capture.export': {'itemIds'}, 'artifacts.open': {'artifactId'}, 'artifacts.export': {'artifactIds', 'taskId'},
    'storage.get_usage': set(), 'storage.preview_delete': {'taskIds'}, 'storage.confirm_delete': {'token'},
    'storage.clean_cache': set(),
    'storage.get_export_location': set(), 'storage.choose_export_location': set(),
    'storage.get_location': set(), 'storage.choose_location': set(), 'storage.clean_old_location': set(),
}


class Bridge:
    def __init__(self, app, trusted_url):
        self._app, self._trusted_url = app, trusted_url

    def invoke(self, action, payload=None):
        try:
            if self._app.window.get_current_url() != self._trusted_url:
                raise ToolboxError('UNSUPPORTED_OPERATION', '只能从工具箱主界面执行操作。')
            if not isinstance(action, str) or action not in FIELDS:
                raise ToolboxError('UNSUPPORTED_OPERATION', '不支持此操作。')
            payload = {} if payload is None else payload
            if type(payload) is not dict or payload.keys() - FIELDS[action]:
                raise ToolboxError('INVALID_PARAMETERS', '操作参数无效。')
            data = self._dispatch(action, payload)
            return {'ok': True, 'data': data, 'error': None}
        except ToolboxError as exc:
            return {'ok': False, 'data': None, 'error': exc.as_dict()}
        except (KeyError, ValueError, TypeError):
            return {'ok': False, 'data': None, 'error': ToolboxError('INVALID_PARAMETERS', '操作参数缺失或格式无效。').as_dict()}
        except OSError:
            return {'ok': False, 'data': None, 'error': ToolboxError('FILE_BUSY', '文件正在使用或无法写入，请稍后重试。', retryable=True).as_dict()}
        except Exception as exc:
            self._app.logs.write(type(exc).__name__ + ': 操作异常', level='error')
            return {'ok': False, 'data': None, 'error': ToolboxError('WORKER_EXITED', '操作未完成，请重试或查看任务日志。').as_dict()}

    def _dispatch(self, action, p):
        a = self._app
        offset, limit = p.get('offset', 0), p.get('limit', 50)
        if action == 'app.get_state':
            return {'version': '0.1.0', 'tools': list(a.descriptors.values()), 'browser': a.browser.state()}
        if action == 'app.show':
            a.show()
            return {}
        if action == 'app.request_exit':
            a.request_exit()
            return {}
        if action == 'events.read':
            return a.events.read(p.get('afterSeq', 0), p.get('limit', 100))
        if action == 'browser.get_state':
            return a.browser.state()
        if action == 'browser.open':
            return a.browser.open(p['source'])
        if action == 'browser.list_pages':
            return a.browser.list_pages()
        if action == 'browser.clear_login':
            if p.get('confirmed') is not True:
                raise ToolboxError('INVALID_PARAMETERS', '请先确认清除受管浏览器登录资料。')
            return a.browser.clear_login()
        if action == 'tools.discover':
            return a.operations.submit('discover', p['toolId'], {})
        if action == 'tasks.create':
            parameters = p.get('parameters', {})
            if p['toolId'] == 'manual-video':
                parameters = {'items': a.capture.selected(p['itemIds'])}
            task = a.scheduler.create(p['toolId'], parameters)
            return {'taskId': task['id']}
        if action == 'tasks.list':
            return a.store.list_tasks(tool_id=p.get('toolId'), state=p.get('state'), offset=offset, limit=p.get('limit', 20))
        if action == 'tasks.get':
            task = a.store.task(p['taskId'])
            return {**task, 'capabilities': a.descriptors.get(task['toolId'], {}), 'artifacts': a.store.artifacts(task['id'])}
        if action == 'tasks.control':
            return a.scheduler.control(p['taskId'], p['command'])
        if action == 'tasks.results':
            return a.operations.results(p['taskId'], offset, limit, p.get('section', 'results'))
        if action == 'tasks.artifacts':
            a.store.task(p['taskId'])
            return a.store.artifacts(p['taskId'], offset, limit)
        if action == 'tasks.logs':
            a.store.task(p['taskId'])
            return a.logs.read(p['taskId'], p.get('afterSeq', 0), p.get('limit', 100))
        if action == 'capture.read_page':
            if not isinstance(p['pageId'], str) or not 1 <= len(p['pageId']) <= 100:
                raise ToolboxError('INVALID_PARAMETERS', '请选择受管浏览器中的页面。')
            return a.operations.submit('capture_page', 'manual-video', {'pageId': p['pageId']})
        if action == 'capture.add_text':
            return a.capture.add_text(p['text'])
        if action == 'capture.list':
            return a.capture.list(offset, limit)
        if action == 'capture.remove':
            return a.capture.remove(p['itemIds'])
        if action == 'capture.copy':
            text, unavailable = a.capture.copy_text(p['itemIds'], p['field'])
            if text:
                clipboard(text)
            return {'unavailable': unavailable, 'copied': len(p['itemIds']) - unavailable}
        if action == 'capture.export':
            return a.files.capture_export(a.capture.selected(p['itemIds']))
        if action == 'artifacts.open':
            return a.files.open(p['artifactId'])
        if action == 'artifacts.export':
            return a.files.export(p['artifactIds'], p.get('taskId'))
        if action == 'storage.get_export_location':
            return a.files.get_export_location()
        if action == 'storage.choose_export_location':
            return a.files.choose_export_location()
        if action == 'storage.get_usage':
            return a.store.usage()
        if action == 'storage.get_location':
            return a.location.status()
        if action == 'storage.choose_location':
            return a.choose_data_location()
        if action == 'storage.clean_old_location':
            with a.scheduler._lock, a.operations._lock, a.store._files_lock:
                from .state import ACTIVE
                if a.scheduler._runs or a.operations._runs or any(a.store.list_tasks(state=s, limit=1)['total'] for s in ACTIVE):
                    raise ToolboxError('BROWSER_BUSY', '请先结束任务和页面读取，再清理旧位置。')
                if not a.location.status().get('previousPath'):
                    return {'removed': False, 'releasedBytes': 0}
                if not a.window.create_confirmation_dialog('清理旧位置', '已在新位置确认任务、视频和登录可用？确定后将清理迁移时保留的旧副本。'):
                    return {'removed': False, 'releasedBytes': 0}
                return a.location.clean_previous()
        if action == 'storage.preview_delete':
            return a.store.preview_delete(p['taskIds'])
        if action == 'storage.confirm_delete':
            return a.store.confirm_delete(p['token'])
        if action == 'storage.clean_cache':
            # Prevent create/resume/start from racing the inactive scratch snapshot.
            with a.scheduler._lock, a.operations._lock:
                return a.files.clean_cache(bool(a.operations._runs))
