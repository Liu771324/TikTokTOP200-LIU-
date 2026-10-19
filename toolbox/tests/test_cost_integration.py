import json
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from toolbox.cost_worker import initialize
from toolbox.engines.cost.locks import create_management_lock
from toolbox.engines.cost.publication import RecoveryRequiredError

from toolbox.host.cost import CostServiceManager
from toolbox.host.errors import ToolboxError
from toolbox.host.paths import DataPaths


class CostIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='toolbox-cost-integration-')
        self.root = Path(self.temporary.name)
        self.manager = CostServiceManager(DataPaths(self.root), SimpleNamespace(write=lambda *a, **k: None), port=0)

    def tearDown(self):
        self.manager.shutdown()
        self.temporary.cleanup()

    def call(self, action, payload=None):
        return self.manager.invoke(action, payload or {})

    def source(self):
        source = self.root / '合成供应商.csv'
        source.write_text('商品编码,成本价\n0001,12.34\nSKU002,0\n', encoding='utf-8-sig')
        chosen = self.manager.stage_input(source)
        layout = self.call('inspect_cost_source', {'path': chosen['path'], 'options': {}})
        self.assertEqual(layout['file_name'], '合成供应商.csv')
        return {'sheet': layout['sheet'], 'header_row': layout['header_row'],
                'mapping': layout['proposed_mapping'], 'scope': layout['scope'], 'source_label': '合成验收',
                'same_catalog': True, 'confirmed_basis': True, 'mode': 'merge'}

    def test_import_one_use_preview_and_shared_service_state(self):
        snapshot = self.call('get_state')
        self.assertTrue(snapshot['owns_service'])
        self.assertTrue(snapshot['expected'])
        self.assertEqual(snapshot['health']['enabled_count'], 0)
        preview = self.call('preview_cost_import', self.source())
        self.assertTrue(preview['ready_to_import'])
        result = self.call('apply_cost_import', {'preview_id': preview['preview_id']})
        self.assertEqual(result['total_count'], 2)
        with self.assertRaises(ToolboxError):
            self.call('apply_cost_import', {'preview_id': preview['preview_id']})
        self.assertEqual(self.call('get_state')['health']['enabled_count'], 2)
        self.assertTrue(self.call('get_update_history'))

    def test_forged_file_identity_and_management_actions_are_blocked(self):
        with self.assertRaisesRegex(ToolboxError, '文件选择'):
            self.call('inspect_cost_source', {'path': '../cost_accounting.sqlite3', 'options': {}})
        with self.assertRaises(ToolboxError):
            self.call('resolve_mapping_review', {'candidate_id': 1})
        with self.assertRaises(ToolboxError):
            self.call('execute', {'command': 'anything'})

    def test_stop_restart_invalidates_preview_and_preserves_catalog(self):
        preview = self.call('preview_cost_import', self.source())
        first = self.call('get_state')['health']['boot_id']
        self.assertTrue(self.call('stop_service'))
        self.assertFalse(self.call('get_state')['expected'])
        self.call('start_service')
        self.assertNotEqual(self.call('get_state')['health']['boot_id'], first)
        with self.assertRaises(ToolboxError):
            self.call('apply_cost_import', {'preview_id': preview['preview_id']})

    def test_worker_crash_recovers_without_replaying_writes(self):
        preview = self.call('preview_cost_import', self.source())
        first = self.call('get_state')['health']['boot_id']
        self.manager._process.kill()
        self.manager._process.wait(timeout=10)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if self.manager._process is not None and self.manager._process.poll() is None:
                try:
                    current = self.call('get_state')
                    if current['expected'] and current['health']['boot_id'] != first:
                        break
                except ToolboxError:
                    pass
            time.sleep(.2)
        else:
            self.fail('cost worker did not recover')
        with self.assertRaises(ToolboxError):
            self.call('apply_cost_import', {'preview_id': preview['preview_id']})
        self.assertEqual(self.call('get_state')['health']['enabled_count'], 0)

    def test_same_port_second_owner_cannot_adopt_or_stop_service(self):
        first = self.call('get_state')
        other = CostServiceManager(DataPaths(self.root / 'other'), SimpleNamespace(write=lambda *a, **k: None), port=self.manager.port)
        try:
            with self.assertRaisesRegex(ToolboxError, '占用|另一'):
                other.invoke('get_state', {})
            if other._process:
                other._process.wait(timeout=10)
        finally:
            other.shutdown()
        self.assertEqual(self.call('get_state')['health']['boot_id'], first['health']['boot_id'])

    def test_repeated_ready_then_crash_exhausts_restart_budget(self):
        self.call('get_state')
        self.manager._closing.set()  # Drive retries deterministically instead of racing the watcher.
        for _ in range(3):
            self.manager._process.kill()
            self.manager._process.wait(timeout=10)
            self.assertTrue(self.call('get_state')['expected'])
        self.manager._process.kill()
        self.manager._process.wait(timeout=10)
        with self.assertRaisesRegex(ToolboxError, '停止自动重启'):
            self.call('get_state')
        self.call('start_service')
        self.assertTrue(self.call('get_state')['expected'])

    def test_initial_recovery_runs_under_database_lock(self):
        root = self.root / 'locked'
        lock = create_management_lock(root / 'cost_accounting.sqlite3')
        observed = []
        def recovering(*args):
            observed.append(lock._thread_lock._is_owned())
            raise RecoveryRequiredError('合成未完成发布，阻止就绪')
        with patch('toolbox.cost_worker.recover_publication', side_effect=recovering):
            with self.assertRaises(RecoveryRequiredError):
                initialize(root, 0)
        self.assertEqual(observed, [True])

    def test_lost_response_after_request_is_not_reported_as_safe_failure(self):
        self.call('get_state')
        with self.manager._lock, patch.object(self.manager, '_receive', side_effect=ToolboxError('COST_UNAVAILABLE', '合成断线')):
            with self.assertRaises(ToolboxError) as failure:
                self.manager._request('get_state', {})
            self.assertEqual(failure.exception.code, 'COST_RESULT_UNCERTAIN')

    def test_public_fee_catalog_round_trip_and_bounded_chunk_transport(self):
        preview = self.call('preview_official_service_fee_catalog')
        self.assertGreater(preview['rule_count'], 100)
        self.call('apply_official_service_fee_catalog', {'preview_id': preview['preview_id']})
        rates = self.call('get_basic_service_fee_rates')
        self.assertEqual(len(rates), preview['rule_count'])
        self.assertGreater(len(json.dumps(rates, ensure_ascii=False).encode()), 128 * 1024)
        self.assertIsInstance(self.call('get_shipping_templates'), list)
        self.assertIsInstance(self.call('get_shipping_product_bindings', {'page': 1}), dict)


if __name__ == '__main__':
    unittest.main()
