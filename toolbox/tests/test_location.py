import json
import shutil
import sqlite3
import hashlib
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from toolbox.host.location import DataLocation, _inventory
from toolbox.host.paths import DataPaths
from toolbox.host.errors import ToolboxError
from toolbox.host.application import Application


class LocationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-location-')
        self.root = Path(self.temp.name)
        self.base = self.root / 'local'
        self.source = self.base / 'ScriptAllToolbox'
        self.source.mkdir(parents=True)
        for name, content in [('toolbox.sqlite3', b'fixture database'), ('media/a.mp4', b'media'),
                              ('tasks/abc/engine-state.json', b'{"relative":"media/a.mp4"}'),
                              ('browser-profile/Default/Network/Cookies', b'login'), ('webview-profile/settings', b'ui')]:
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        self.location = DataLocation(self.base, forbidden=(self.root / 'program',))
        self.target = self.root / 'other-drive/data'
        (self.source / 'toolbox.sqlite3').unlink()
        with closing(sqlite3.connect(self.source / 'toolbox.sqlite3')) as db:
            db.executescript('CREATE TABLE artifacts(id TEXT,relpath TEXT,size INTEGER,sha256 TEXT,status TEXT);'
                             'CREATE TABLE task_artifacts(artifact_id TEXT);')
            db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?)',
                       ('a', 'media/a.mp4', 5, hashlib.sha256(b'media').hexdigest(), 'ready'))
            db.execute('INSERT INTO task_artifacts VALUES(?)', ('a',))
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def test_default_and_requested_root_do_not_switch_before_copy(self):
        with patch('toolbox.host.location.DataLocation', return_value=self.location):
            self.assertEqual(DataPaths.default().root, self.source)
            self.location.request(self.target)
            self.assertEqual(DataPaths.default().root, self.source)
            self.assertTrue(self.location.status()['pending'])

    def test_copy_hashes_then_switch_and_clean_verified_old_root(self):
        expected = _inventory(self.source)
        self.location.request(self.target)
        self.assertTrue(self.location.migrate_pending())
        self.assertEqual(self.location.current(), self.target)
        self.assertFalse(self.location.status()['pending'])
        self.assertEqual(self.location.status()['previousPath'], str(self.source))
        self.assertTrue(self.source.exists())
        self.assertEqual(_inventory(self.target, (self.location.read()['previous']['receipt'],)), expected)
        result = self.location.clean_previous()
        self.assertTrue(result['removed'])
        self.assertFalse(self.source.exists())
        self.assertEqual(_inventory(self.target), expected)
        self.assertFalse(self.location.clean_previous()['removed'])

    def test_copy_interrupted_is_resumable_without_switch(self):
        self.location.request(self.target)
        copy = shutil.copy2
        calls = 0
        def interrupted(source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                Path(target).write_bytes(b'partial')
                raise OSError('fixture interruption')
            return copy(source, target)
        with patch('toolbox.host.location.shutil.copy2', side_effect=interrupted):
            with self.assertRaises(OSError):
                self.location.migrate_pending()
        self.assertEqual(self.location.current(), self.source)
        self.assertTrue(self.location.migrate_pending())
        self.assertEqual(self.location.current(), self.target)

    def test_source_change_during_copy_does_not_switch(self):
        self.location.request(self.target)
        copy = shutil.copy2
        def changed(source, target):
            result = copy(source, target)
            (self.source / 'toolbox.sqlite3').write_bytes(b'changed')
            return result
        with patch('toolbox.host.location.shutil.copy2', side_effect=changed):
            with self.assertRaises(ToolboxError):
                self.location.migrate_pending()
        self.assertEqual(self.location.current(), self.source)

    def test_nonempty_overlap_program_and_system_targets_rejected(self):
        occupied = self.root / 'occupied'
        occupied.mkdir()
        (occupied / 'keep').write_text('keep')
        for target in (occupied, self.source, self.source / 'child', self.base,
                       self.root / 'program/data', Path(self.root.anchor)):
            with self.subTest(target=target), self.assertRaises(ToolboxError):
                self.location.request(target)
        self.assertEqual((occupied / 'keep').read_text(), 'keep')

    def test_foreign_file_after_request_prevents_copy(self):
        self.location.request(self.target)
        self.target.mkdir(parents=True)
        (self.target / 'keep').write_text('keep')
        with self.assertRaises(ToolboxError):
            self.location.migrate_pending()
        self.assertEqual(self.location.current(), self.source)

    def test_space_insufficient_request_preserves_old_configuration(self):
        with patch('toolbox.host.location.shutil.disk_usage', return_value=shutil._ntuple_diskusage(100, 99, 1)):
            with self.assertRaises(ToolboxError):
                self.location.request(self.target)
        self.assertFalse(self.location.settings.exists())

    def test_link_rejected(self):
        link = self.root / 'link'
        try:
            link.symlink_to(self.source, target_is_directory=True)
        except OSError:
            self.skipTest('Account cannot create symlinks')
        with self.assertRaises(ToolboxError):
            self.location.request(link / 'target')

    def test_changed_old_copy_is_not_deleted(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        (self.source / 'toolbox.sqlite3').write_bytes(b'new old-version data')
        with self.assertRaises(ToolboxError):
            self.location.clean_previous()
        self.assertTrue(self.source.exists())

    def test_partial_cleanup_can_resume(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        def interrupted(root):
            (root / 'media/a.mp4').unlink()
            raise PermissionError('fixture busy')
        with patch('toolbox.host.location.shutil.rmtree', side_effect=interrupted):
            with self.assertRaises(PermissionError):
                self.location.clean_previous()
        self.assertTrue(self.location.clean_previous()['removed'])
        self.assertFalse(self.source.exists())

    def test_missing_data_drive_does_not_fall_back_to_empty_database(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        shutil.rmtree(self.target)
        with self.assertRaises(ToolboxError):
            self.location.current()

    def test_missing_database_does_not_create_empty_database(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        (self.target / 'toolbox.sqlite3').unlink()
        with self.assertRaises(ToolboxError):
            self.location.current()
        self.assertFalse((self.target / 'toolbox.sqlite3').exists())

    def test_corrupt_current_database_preserves_old_copy(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        (self.target / 'toolbox.sqlite3').write_bytes(b'broken')
        with self.assertRaises(ToolboxError):
            self.location.clean_previous()
        self.assertTrue(self.source.exists())

    def test_missing_or_corrupt_new_media_preserves_old_copy(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        file = self.target / 'media/a.mp4'
        file.unlink()
        with self.assertRaises(ToolboxError):
            self.location.clean_previous()
        file.write_bytes(b'bad!!')
        with self.assertRaises(ToolboxError):
            self.location.clean_previous()
        self.assertTrue(self.source.exists())

    def test_normal_new_database_updates_allow_cleanup(self):
        self.location.request(self.target)
        self.location.migrate_pending()
        with closing(sqlite3.connect(self.target / 'toolbox.sqlite3')) as db:
            db.execute('CREATE TABLE new_results(value TEXT)')
            db.execute("INSERT INTO new_results VALUES('normal usage')")
            db.commit()
        self.assertTrue(self.location.clean_previous()['removed'])

    def test_corrupt_configuration_is_not_ignored(self):
        self.location.settings.parent.mkdir(parents=True)
        self.location.settings.write_text('{broken', encoding='utf-8')
        with self.assertRaises(ToolboxError):
            self.location.current()

    def test_pending_migration_status_records_retry_error(self):
        self.location.request(self.target)
        self.location.record_failure()
        status = self.location.status()
        self.assertTrue(status['pending'])
        self.assertIn('仍使用原数据', status['error'])

    def test_user_home_pointer_imports_legacy_config_and_is_stable(self):
        self.location.request(self.target)
        home = self.root / 'home'
        with patch.dict('os.environ', {'LOCALAPPDATA': str(self.base), 'USERPROFILE': str(home)}):
            location = DataLocation()
            self.assertEqual(location.settings, home / '.scriptall-toolbox/settings.json')
            self.assertEqual(location.current(), self.source)
            self.assertTrue(location.settings.is_file())

    def test_preexisting_missing_assets_remain_recorded_without_blocking_cleanup(self):
        with closing(sqlite3.connect(self.source / 'toolbox.sqlite3')) as db:
            db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?)', ('old-missing', 'media/old.mp4', 10, 'missing', 'missing'))
            db.execute('INSERT INTO task_artifacts VALUES(?)', ('old-missing',))
            db.commit()
        self.location.request(self.target)
        self.location.migrate_pending()
        self.assertTrue(self.location.clean_previous()['removed'])

    def test_active_tasks_block_folder_dialog(self):
        app = MagicMock()
        app.scheduler._runs = {}
        app.operations._runs = {}
        app.store.list_tasks.return_value = {'total': 1}
        with self.assertRaises(ToolboxError):
            Application.choose_data_location(app)
        app.window.create_file_dialog.assert_not_called()

    def test_folder_cancel_and_confirmation_cancel_do_not_write_settings(self):
        app = MagicMock()
        app.scheduler._runs = {}
        app.operations._runs = {}
        app.store.list_tasks.return_value = {'total': 0}
        app.window.create_file_dialog.return_value = None
        self.assertTrue(Application.choose_data_location(app)['cancelled'])
        app.window.create_file_dialog.return_value = [str(self.root / 'selected')]
        app.window.create_confirmation_dialog.return_value = False
        self.assertTrue(Application.choose_data_location(app)['cancelled'])
        app.location.request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
