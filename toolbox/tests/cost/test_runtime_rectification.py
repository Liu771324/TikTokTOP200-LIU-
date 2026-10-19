import socket
import tempfile
import unittest
from pathlib import Path

from toolbox.engines.cost.database import connect_database
from toolbox.engines.cost.desktop_app import AssistantService, ServicePaths, probe_health, probe_service_statistics
from toolbox.engines.cost.publication import publication_journal


class RuntimeRectificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "empty.sqlite3"
        with connect_database(self.database):
            pass
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.service = AssistantService(ServicePaths(self.database, self.root / "cost.xlsx", self.root / "logs"), port=port)

    def tearDown(self):
        self.service.stop()
        self.temporary.cleanup()

    def test_same_directory_restart_keeps_identity_changes_boot_and_invalidates_preview(self):
        self.service.start()
        before = probe_health(self.service.port)
        self.service.admin.cost_import_manager.session = {"preview_id": "old"}
        self.service.stop()
        self.service.start()
        after = probe_health(self.service.port)
        self.assertEqual(before["service_id"], after["service_id"])
        self.assertNotEqual(before["boot_id"], after["boot_id"])
        self.assertIsNone(self.service.admin.cost_import_manager.session)
        self.assertTrue(after["ready"])

    def test_health_marks_statistics_stale_and_status_refreshes_them(self):
        self.service.start()
        with connect_database(self.database) as connection:
            connection.execute("INSERT INTO products(sku_id,name,cost_price,enabled,synced_at) VALUES('NEW','合成', '1',1,'now')")
        health = probe_health(self.service.port)
        self.assertTrue(health["statistics_stale"])
        statistics = probe_service_statistics(self.service.port)
        self.assertEqual(1, statistics["enabled_count"])
        self.assertFalse(statistics["statistics_stale"])

    def test_pending_recovery_is_visible_and_malformed_journal_does_not_start_ready(self):
        self.service.start()
        publication_journal(self.database).write_bytes(b'{"version":')
        health = probe_health(self.service.port)
        self.assertEqual("recovering", health["status"])
        self.assertFalse(health["ready"])
        self.service.stop()
        with self.assertRaises(RuntimeError):
            self.service.start()
        self.assertIsNone(probe_health(self.service.port))


if __name__ == "__main__":
    unittest.main()
