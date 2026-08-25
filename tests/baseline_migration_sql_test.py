"""Regression test for the atomic D1 baseline-migration empty-target gate."""

import sqlite3
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "drizzle" / "0000_legal_marrow.sql",
    ROOT / "drizzle" / "0001_import-version-status.sql",
    ROOT / "drizzle" / "0002_broad_runaways.sql",
    ROOT / "drizzle" / "0003_inventory_identity.sql",
]


class BaselineMigrationSqlTest(unittest.TestCase):
    def test_baseline_lock_aborts_before_deleting_an_operational_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            connection = sqlite3.connect(Path(directory) / "migration.db")
            try:
                for migration in MIGRATIONS:
                    connection.executescript(migration.read_text())
                connection.execute(
                    "INSERT INTO import_batches (filename, created_at, summary_json, errors_json) VALUES (?, ?, ?, ?)",
                    ("normal-import.xlsx", "2026-08-02T00:00:00", "{}", "[]"),
                )
                connection.execute(
                    "INSERT INTO parts (material_number, target_months, safety_months, active, inbound_qty, imported_planned_qty, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("P-EXISTING", 6, 3, 1, 0, 0, "2026-08-02T00:00:00"),
                )

                with self.assertRaisesRegex(sqlite3.IntegrityError, "baseline target must be empty"):
                    connection.execute(
                        "INSERT INTO baseline_migrations (migration_key, version_id, created_at) VALUES (?, ?, ?)",
                        ("csd-v022-baseline", 1, "2026-08-02T00:00:00"),
                    )

                self.assertEqual(connection.execute("SELECT COUNT(*) FROM parts").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM baseline_migrations").fetchone()[0], 0)
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
