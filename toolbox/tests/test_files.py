import errno
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from openpyxl import load_workbook

from toolbox.host.errors import ToolboxError
from toolbox.host.files import Files
from toolbox.host.paths import DataPaths
from toolbox.host.store import Store


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-export-test-')
        self.root = Path(self.temp.name)
        self.store = Store(DataPaths(self.root / 'internal'))
        self.out = self.root / 'external'
        self.out.mkdir()
        self.files = Files(self.store)
        self.files.window = SimpleNamespace(create_file_dialog=Mock(return_value=(str(self.out),)))
        self.webview = patch.dict('sys.modules', {'webview': SimpleNamespace(FileDialog=SimpleNamespace(SAVE='save', FOLDER='folder'))})
        self.webview.start()

    def tearDown(self):
        self.webview.stop()
        self.store.close()
        self.temp.cleanup()

    def task(self, tool='video-ranking'):
        return self.store.create_task(tool, {})

    def artifact(self, task, name='商品视频.mp4', *, caption='配套文案', product='脱敏商品', key='one', content=b'fixture-video', kind='video', metadata=None):
        context = self.store.paths.task_context(task, '')
        source = Path(context['artifactStagingRoot']) / (key + ('.mp4' if kind == 'video' else '.xlsx'))
        source.write_bytes(content)
        candidate = {'candidateId': key, 'kind': kind, 'role': kind, 'relpath': self.store.paths.relative(source),
                     'displayName': name, 'metadata': metadata if metadata is not None else {'caption': caption, 'title': name, 'productName': product}}
        result = self.store.register(task['id'], task['attempt'], candidate, validate_video=lambda path: None)
        return result['artifactId']

    def assert_counts(self, result, exported=0, skipped=0, failed=0):
        self.assertEqual((result['exported'], result['skipped'], result['failed']), (exported, skipped, failed))

    def test_python_business_reports_keep_json_and_markdown_extensions(self):
        task = self.task('business-center')
        context = self.store.paths.task_context(task, '')
        ids = []
        for extension in ('.json', '.md'):
            source = Path(context['artifactStagingRoot']) / ('business-report' + extension)
            source.write_text('{}' if extension == '.json' else '# 商机报告', encoding='utf-8')
            registered = self.store.register(task['id'], task['attempt'], {
                'candidateId': 'report' + extension, 'kind': 'text', 'role': 'report' + extension,
                'relpath': self.store.paths.relative(source), 'displayName': '商机中心' + extension})
            ids.append(registered['artifactId'])
            self.assertEqual(self.store.artifact_path(ids[-1]).suffix, extension)
        self.assert_counts(self.files.export(ids, task['id']), exported=2)
        self.assertEqual({path.name for path in self.out.iterdir()}, {'商机中心.json', '商机中心.md'})
        selected = self.out / '另存.json'
        self.files.window.create_file_dialog.return_value = (str(selected),)
        self.assert_counts(self.files.export([ids[0]], task['id']), exported=1)
        self.assertEqual(self.files.window.create_file_dialog.call_args.kwargs['save_filename'], '商机中心.json')

    def test_export_location_starts_empty_and_selection_persists(self):
        self.assertEqual(self.files.get_export_location(), {'path': None})
        self.assertEqual(self.files.choose_export_location(), {'path': str(self.out), 'cancelled': False})
        self.assertEqual(Files(self.store).get_export_location(), {'path': str(self.out)})
        self.assertEqual(json.loads(self.store.paths.resolve('preferences.json').read_text('utf-8')),
                         {'version': 1, 'exportDirectory': str(self.out)})
        self.assertEqual(list(self.store.paths.root.glob('.preferences-*')), [])
        self.assertEqual(list(self.out.iterdir()), [])  # Choosing never copies a business result.

    def test_export_location_cancel_preserves_existing_preference(self):
        self.files.choose_export_location()
        before = self.store.paths.resolve('preferences.json').read_bytes()
        self.files.window.create_file_dialog.return_value = None
        self.assertEqual(self.files.choose_export_location(), {'cancelled': True})
        self.assertEqual(self.store.paths.resolve('preferences.json').read_bytes(), before)

    def test_export_location_rejects_internal_directory_and_keeps_setting(self):
        self.files.choose_export_location()
        for directory in (self.store.paths.root, self.store.paths.resolve('scratch')):
            self.files.window.create_file_dialog.return_value = (str(directory),)
            with self.assertRaises(ToolboxError):
                self.files.choose_export_location()
        self.assertEqual(self.files.get_export_location(), {'path': str(self.out)})

    def test_export_location_atomic_failure_preserves_existing_setting(self):
        self.files.choose_export_location()
        before = self.store.paths.resolve('preferences.json').read_bytes()
        with patch('toolbox.host.files.os.replace', side_effect=PermissionError(errno.EACCES, 'fixture busy')):
            with self.assertRaises(ToolboxError):
                self.files.choose_export_location()
        self.assertEqual(self.store.paths.resolve('preferences.json').read_bytes(), before)
        self.assertEqual(list(self.store.paths.root.glob('.preferences-*')), [])

    def test_export_location_invalid_preferences_do_not_become_an_arbitrary_path(self):
        preference = self.store.paths.resolve('preferences.json')
        for value in ('{broken', json.dumps({'version': 2, 'exportDirectory': str(self.out)}),
                      json.dumps({'version': 1, 'exportDirectory': str(self.store.paths.root)})):
            preference.write_text(value, encoding='utf-8')
            with self.assertRaises(ToolboxError):
                self.files.get_export_location()
        self.files.choose_export_location()  # Can repair a malformed setting by choosing again.
        self.assertEqual(self.files.get_export_location(), {'path': str(self.out)})

    def test_default_video_export_skips_picker_and_preserves_pairs_and_collision_names(self):
        task = self.task()
        artifact = self.artifact(task, caption='默认目录文案')
        self.files.choose_export_location()
        self.files.window.create_file_dialog.reset_mock()
        self.assert_counts(self.files.export([artifact], task['id']), exported=1)
        self.assert_counts(self.files.export([artifact], task['id']), exported=1)
        self.files.window.create_file_dialog.assert_not_called()
        videos = list(self.out.rglob('*.mp4'))
        self.assertEqual(len(videos), 2)
        self.assertEqual(len({video.name for video in videos}), 2)
        for video in videos:
            self.assertEqual(video.with_suffix('.txt').read_text('utf-8'), '默认目录文案')
        self.assertEqual(self.store.artifact_path(artifact).read_bytes(), b'fixture-video')

    def test_default_report_and_capture_export_only_set_save_dialog_directory(self):
        self.files.choose_export_location()
        task = self.task('top200')
        artifact = self.artifact(task, '报告.xlsx', kind='excel')
        self.files.window.create_file_dialog.return_value = None
        self.assertTrue(self.files.export([artifact], task['id'])['cancelled'])
        self.assertEqual(self.files.window.create_file_dialog.call_args.args, ('save',))
        self.assertEqual(self.files.window.create_file_dialog.call_args.kwargs['directory'], str(self.out))
        self.assertTrue(self.files.capture_export(self.capture_items())['cancelled'])
        self.assertEqual(self.files.window.create_file_dialog.call_args.kwargs['directory'], str(self.out))
        self.assertEqual(list(self.out.iterdir()), [])

    def test_export_location_bridge_accepts_only_empty_payload(self):
        from toolbox.host.bridge import Bridge
        app = SimpleNamespace(window=SimpleNamespace(get_current_url=lambda: 'trusted'), files=self.files)
        bridge = Bridge(app, 'trusted')
        for action in ('storage.get_export_location', 'storage.choose_export_location'):
            self.assertTrue(bridge.invoke(action, {})['ok'])
            self.assertFalse(bridge.invoke(action, {'path': str(self.out)})['ok'])

    def test_single_report_uses_reference_name_and_atomic_confirmed_replace(self):
        task = self.task('top200')
        artifact = self.artifact(task, '商品排行榜.xlsx', content=b'complete report', kind='excel')
        target = self.out / '用户确认的报告.xlsx'
        target.write_bytes(b'old report')
        self.files.window.create_file_dialog.return_value = (str(target),)
        result = self.files.export([artifact])
        self.assert_counts(result, exported=1)
        self.assertEqual(target.read_bytes(), b'complete report')
        self.assertEqual(self.files.window.create_file_dialog.call_args.kwargs['save_filename'], '商品排行榜.xlsx')
        self.assertEqual(self.store.artifact_path(artifact).read_bytes(), b'complete report')
        self.assertEqual(list(self.out.glob('.toolbox-export-*')), [])

    def test_report_write_failure_preserves_existing_target_and_internal_source(self):
        task = self.task('top200')
        artifact = self.artifact(task, '报告.xlsx', kind='excel')
        target = self.out / '报告.xlsx'
        target.write_bytes(b'existing user file')
        self.files.window.create_file_dialog.return_value = (str(target),)
        def partial(incoming, outgoing):
            outgoing.write(b'partial')
            raise OSError(errno.ENOSPC, 'fixture disk full')
        with patch('toolbox.host.files.shutil.copyfileobj', side_effect=partial):
            result = self.files.export([artifact], task['id'])
        self.assert_counts(result, failed=1)
        self.assertEqual(result['errors'][0]['code'], 'DISK_FULL')
        self.assertEqual(target.read_bytes(), b'existing user file')
        self.assertEqual(self.store.artifact_path(artifact).read_bytes(), b'fixture-video')
        self.assertEqual(list(self.out.glob('.toolbox-export-*')), [])

    def test_busy_single_replace_preserves_target(self):
        task = self.task('top200')
        artifact = self.artifact(task, '报告.xlsx', kind='excel')
        target = self.out / '报告.xlsx'
        target.write_bytes(b'old')
        self.files.window.create_file_dialog.return_value = (str(target),)
        with patch('toolbox.host.files.os.replace', side_effect=PermissionError(errno.EACCES, 'fixture busy')):
            result = self.files.export([artifact])
        self.assert_counts(result, failed=1)
        self.assertEqual(result['errors'][0]['code'], 'FILE_IN_USE')
        self.assertEqual(target.read_bytes(), b'old')
        self.assertEqual(list(self.out.glob('.toolbox-export-*')), [])

    def test_video_uses_folder_and_exports_caption_in_task_product_group(self):
        task = self.task()
        artifact = self.artifact(task, '中文商品视频.mp4', caption='第一行\n第二行', product='商品 A')
        result = self.files.export([artifact], task['id'])
        self.assert_counts(result, exported=1)
        self.assertEqual(self.files.window.create_file_dialog.call_args.args, ('folder',))
        videos = list(self.out.rglob('*.mp4'))
        self.assertEqual(len(videos), 1)
        self.assertEqual(videos[0].name, '中文商品视频.mp4')
        self.assertEqual(videos[0].parent.name, '商品 A')
        self.assertTrue(videos[0].parent.parent.name.startswith('自动短视频-'))
        self.assertEqual(videos[0].with_suffix('.txt').read_text('utf-8'), '第一行\n第二行')

    def test_shared_video_preserves_each_task_caption_and_same_task_references(self):
        first, second = self.task(), self.task()
        artifact = self.artifact(first, '视频.mp4', key='one', product='商品一', caption='商品一文案')
        same = self.artifact(first, '视频.mp4', key='two', product='商品二', caption='商品二文案')
        reused = self.artifact(second, '视频.mp4', key='three', product='商品三', caption='另一个任务文案')
        self.assertEqual(artifact, same)
        self.assertEqual(artifact, reused)
        self.assert_counts(self.files.export([artifact], first['id']), exported=2)
        self.assert_counts(self.files.export([artifact], second['id']), exported=1)
        self.assertEqual(sorted(path.read_text('utf-8') for path in self.out.rglob('*.txt')),
                         sorted(['商品一文案', '商品二文案', '另一个任务文案']))
        self.assertEqual(len(list(self.out.rglob('*.mp4'))), 3)

    def test_missing_caption_is_explicit_and_ambiguous_legacy_reference_uses_generic_name(self):
        first, second = self.task(), self.task()
        artifact = self.artifact(first, '标题一.mp4', caption='第一任务')
        self.artifact(second, '标题二.mp4', caption='第二任务')
        self.assert_counts(self.files.export([artifact]), exported=1)
        video = next(self.out.rglob('*.mp4'))
        self.assertEqual(video.name, '工具箱结果.mp4')
        self.assertEqual(video.with_suffix('.txt').read_text('utf-8'), '未获取到文案。')

    def test_batch_names_increment_without_overwriting_video_or_caption(self):
        task = self.task()
        artifact = self.artifact(task, '同名.mp4')
        self.assert_counts(self.files.export([artifact], task['id']), exported=1)
        first = next(self.out.rglob('*.mp4'))
        first.with_suffix('.txt').write_text('用户已有文案', encoding='utf-8')
        self.assert_counts(self.files.export([artifact], task['id']), exported=1)
        self.assertEqual(first.with_suffix('.txt').read_text('utf-8'), '用户已有文案')
        self.assertEqual(first.with_name('同名 (2).mp4').read_bytes(), b'fixture-video')
        self.assertEqual(first.with_name('同名 (2).txt').read_text('utf-8'), '配套文案')

    def test_batch_reports_increment_names_and_only_failed_item_is_counted(self):
        task = self.task('top200')
        first = self.artifact(task, '报告.xlsx', key='one', content=b'first', kind='excel')
        second = self.artifact(task, '报告.xlsx', key='two', content=b'second', kind='excel')
        (self.out / '报告.xlsx').write_bytes(b'existing')
        self.assert_counts(self.files.export([first, second], task['id']), exported=2)
        self.assertEqual((self.out / '报告.xlsx').read_bytes(), b'existing')
        self.assertEqual((self.out / '报告 (2).xlsx').read_bytes(), b'first')
        self.assertEqual((self.out / '报告 (3).xlsx').read_bytes(), b'second')
        self.store.artifact_path(second).unlink()
        self.assert_counts(self.files.export([first, second], task['id']), exported=1, failed=1)

    def test_cancel_does_not_write_or_change_internal_result(self):
        task = self.task()
        artifact = self.artifact(task)
        self.files.window.create_file_dialog.return_value = None
        result = self.files.export([artifact], task['id'])
        self.assert_counts(result, skipped=1)
        self.assertTrue(result['cancelled'])
        self.assertEqual(list(self.out.iterdir()), [])
        self.assertEqual(self.store.artifact_path(artifact).read_bytes(), b'fixture-video')

    def test_internal_destination_and_resolved_link_to_internal_are_rejected(self):
        task = self.task()
        artifact = self.artifact(task)
        self.files.window.create_file_dialog.return_value = (str(self.store.paths.root / 'media'),)
        self.assert_counts(self.files.export([artifact], task['id']), failed=1)
        outside_link = self.out / 'mock-junction'
        original_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            return self.store.paths.root / 'media' if path == outside_link else original_resolve(path, *args, **kwargs)
        self.files.window.create_file_dialog.return_value = (str(outside_link),)
        with patch.object(Path, 'resolve', resolve):
            result = self.files.export([artifact], task['id'])
        self.assert_counts(result, failed=1)
        self.assertEqual(result['errors'][0]['code'], 'INVALID_PARAMETERS')
        self.assertEqual(list(self.out.iterdir()), [])
        self.assertEqual(len(list((self.store.paths.root / 'media').iterdir())), 1)

    def test_extended_windows_path_cannot_alias_internal_data_root(self):
        extended = Path('\\\\?\\' + str(self.store.paths.root / 'media'))
        with self.assertRaises(ToolboxError) as raised:
            self.files._external(extended)
        self.assertEqual(raised.exception.code, 'INVALID_PARAMETERS')

    def test_video_pair_staging_failure_leaves_no_partial_final_files(self):
        task = self.task()
        artifact = self.artifact(task)
        with patch('toolbox.host.files.os.fsync', side_effect=[None, OSError(errno.ENOSPC, 'fixture caption disk full')]):
            result = self.files.export([artifact], task['id'])
        self.assert_counts(result, failed=1)
        self.assertEqual(list(self.out.rglob('*.mp4')), [])
        self.assertEqual(list(self.out.rglob('*.txt')), [])
        self.assertEqual(list(self.out.rglob('.toolbox-export-*')), [])

    def test_second_video_publish_busy_rolls_back_only_this_pair(self):
        task = self.task()
        artifact = self.artifact(task)
        rename = __import__('os').rename
        def publish(source, target):
            if str(target).endswith('.txt'):
                raise PermissionError(errno.EACCES, 'fixture busy caption')
            return rename(source, target)
        with patch('toolbox.host.files.os.rename', side_effect=publish):
            result = self.files.export([artifact], task['id'])
        self.assert_counts(result, failed=1)
        self.assertEqual(list(self.out.rglob('*.mp4')), [])
        self.assertEqual(list(self.out.rglob('.toolbox-export-*')), [])

    def test_publish_collision_keeps_competing_caption_and_retries_the_pair(self):
        task = self.task()
        artifact = self.artifact(task, '同名.mp4')
        rename = __import__('os').rename
        competed = False
        def publish(source, target):
            nonlocal competed
            if str(target).endswith('.txt') and not competed:
                competed = True
                Path(target).write_text('其他导出进程的文案', encoding='utf-8')
                raise FileExistsError(errno.EEXIST, 'fixture competing publisher')
            return rename(source, target)
        with patch('toolbox.host.files.os.rename', side_effect=publish):
            self.assert_counts(self.files.export([artifact], task['id']), exported=1)
        video = next(self.out.rglob('*.mp4'))
        self.assertEqual(video.name, '同名 (2).mp4')
        self.assertEqual(video.with_suffix('.txt').read_text('utf-8'), '配套文案')
        self.assertEqual(video.with_name('同名.txt').read_text('utf-8'), '其他导出进程的文案')
        self.assertEqual(list(self.out.rglob('.toolbox-export-*')), [])

    def test_rollback_does_not_remove_an_external_replacement(self):
        task = self.task()
        artifact = self.artifact(task)
        rename = __import__('os').rename
        def publish(source, target):
            if str(target).endswith('.mp4'):
                rename(source, target)
                Path(target).write_bytes(b'another writer replaced this video')
            elif str(target).endswith('.txt'):
                raise PermissionError(errno.EACCES, 'fixture caption busy')
            else:
                rename(source, target)
        with patch('toolbox.host.files.os.rename', side_effect=publish):
            self.assert_counts(self.files.export([artifact], task['id']), failed=1)
        video = next(self.out.rglob('*.mp4'))
        self.assertEqual(video.read_bytes(), b'another writer replaced this video')

    def test_chinese_illegal_reserved_long_and_equal_titles_are_safe(self):
        task = self.task()
        first = self.artifact(task, 'CON.mp4', product='商品<>:"/\\|?*', key='one', content=b'one')
        second = self.artifact(task, '中文' * 100 + '.mp4', product='商品' * 100, key='two', content=b'two')
        self.assert_counts(self.files.export([first, second], task['id']), exported=2)
        videos = list(self.out.rglob('*.mp4'))
        self.assertEqual(len(videos), 2)
        self.assertTrue(any(path.name.startswith('结果_CON') for path in videos))
        for path in videos:
            self.assertLessEqual(len(str(path)), 240)
            self.assertFalse(any(character in path.name for character in '<>:"/\\|?*'))

    def test_long_export_folder_preserves_task_identity_and_separates_truncated_products(self):
        task = self.task()
        first = self.artifact(task, '中文标题' * 50 + '.mp4', product='商品' * 70 + '一', key='one', content=b'one')
        second = self.artifact(task, '中文标题' * 50 + '.mp4', product='商品' * 70 + '二', key='two', content=b'two')
        long_folder = self.out / ('中文' * 35)
        long_folder.mkdir()
        self.files.window.create_file_dialog.return_value = (str(long_folder),)
        self.assert_counts(self.files.export([first, second], task['id']), exported=2)
        videos = list(long_folder.rglob('*.mp4'))
        self.assertEqual(len({video.parent for video in videos}), 2)
        for video in videos:
            self.assertTrue(video.parent.parent.name.endswith(task['id'][:8]))
            self.assertLessEqual(len(str(video)), 240)

    def test_validation_missing_reference_and_duplicate_ids(self):
        task, other = self.task(), self.task()
        artifact = self.artifact(task)
        for invalid in [[], ['x'] * 201, [None], [{}], 'x']:
            with self.assertRaises(ToolboxError):
                self.files.export(invalid)
        self.assert_counts(self.files.export([artifact], other['id']), failed=1)
        self.assert_counts(self.files.export([artifact, artifact], task['id']), exported=1)

    def test_task_references_paginate_and_expansion_is_limited(self):
        task = self.task()
        artifact = self.artifact(task)
        reference = self.store.artifacts(task['id'])['items'][0]
        with patch.object(self.store, 'artifacts', side_effect=[{'items': [reference] * 200, 'total': 201}, {'items': [reference], 'total': 201}]) as pages:
            with self.assertRaises(ToolboxError):
                self.files.export([artifact], task['id'])
        self.assertEqual(pages.call_args_list[1].kwargs['offset'], 200)
        self.files.window.create_file_dialog.assert_not_called()

    @staticmethod
    def capture_items():
        return [{'title': '=SUM(1,2)', 'publicUrl': '+link', 'linkKind': '-formula', 'sourcePage': '@source', 'capturedAt': '=NOW()'},
                {'title': '中文标题', 'publicUrl': None, 'linkKind': 'temporary_media', 'sourcePage': 'compass_ranking', 'capturedAt': '2026-10-12'}]

    def test_capture_excel_is_formula_safe_and_atomic(self):
        target = self.out / '待选视频.xlsx'
        target.write_bytes(b'existing')
        self.files.window.create_file_dialog.return_value = (str(target),)
        self.assert_counts(self.files.capture_export(self.capture_items()), exported=2)
        workbook = load_workbook(target)
        self.assertEqual(workbook.active['A2'].value, '=SUM(1,2)')
        self.assertTrue(all(cell.data_type == 's' for cell in workbook.active[2]))
        self.assertEqual(workbook.active['B3'].value, '需重新读取临时链接')
        workbook.close()
        self.assertEqual(list(self.out.glob('.toolbox-export-*')), [])

    def test_capture_failure_and_cancel_preserve_existing_target(self):
        target = self.out / '待选视频.xlsx'
        target.write_bytes(b'old')
        self.files.window.create_file_dialog.return_value = (str(target),)
        def broken(workbook, stream):
            stream.write(b'partial workbook')
            raise PermissionError(errno.EACCES, 'fixture busy')
        with patch('openpyxl.Workbook.save', broken):
            result = self.files.capture_export(self.capture_items())
        self.assert_counts(result, failed=2)
        self.assertEqual(result['errors'][0]['code'], 'FILE_IN_USE')
        self.assertEqual(target.read_bytes(), b'old')
        self.assertEqual(list(self.out.glob('.toolbox-export-*')), [])
        self.files.window.create_file_dialog.return_value = None
        self.assert_counts(self.files.capture_export(self.capture_items()), skipped=2)

    def test_capture_internal_target_and_batch_limit(self):
        self.files.window.create_file_dialog.return_value = (str(self.store.paths.root / 'capture.xlsx'),)
        result = self.files.capture_export(self.capture_items())
        self.assert_counts(result, failed=2)
        self.assertFalse((self.store.paths.root / 'capture.xlsx').exists())
        for invalid in [[], self.capture_items() * 101, [None]]:
            with self.assertRaises(ToolboxError):
                self.files.capture_export(invalid)


if __name__ == '__main__':
    unittest.main()
