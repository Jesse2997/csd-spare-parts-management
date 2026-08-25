"""Regression tests for canonical inventory identity storage."""

import sqlite3
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE_MIGRATIONS = [
    ROOT / "drizzle" / "0000_legal_marrow.sql",
    ROOT / "drizzle" / "0001_import-version-status.sql",
    ROOT / "drizzle" / "0002_broad_runaways.sql",
]
IDENTITY_MIGRATION = ROOT / "drizzle" / "0003_inventory_identity.sql"


class InventoryIdentitySqlTest(unittest.TestCase):
    def test_migration_canonicalizes_and_aggregates_existing_inventory_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            connection = sqlite3.connect(Path(directory) / "migration.db")
            try:
                for migration in BASE_MIGRATIONS:
                    connection.executescript(migration.read_text())
                connection.execute(
                    "INSERT INTO import_batches (filename, created_at, summary_json, errors_json) VALUES (?, ?, ?, ?)",
                    ("inventory.xlsx", "2026-08-02T00:00:00", "{}", "[]"),
                )
                connection.executemany(
                    "INSERT INTO stock_snapshots (batch_id, material_number, warehouse, bin_location, quantity) VALUES (?, ?, ?, ?, ?)",
                    [(1, "P-001", "CSD", None, 10), (1, "P-001", " csd ", None, 3)],
                )

                connection.executescript(IDENTITY_MIGRATION.read_text())

                self.assertEqual(
                    connection.execute(
                        "SELECT warehouse, material_number, bin_location, quantity FROM stock_snapshots"
                    ).fetchall(),
                    [("CSD", "P-001", None, 13.0)],
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "INSERT INTO stock_snapshots (batch_id, material_number, warehouse, bin_location, quantity) VALUES (?, ?, ?, ?, ?)",
                        (1, "P-001", "csd", None, 1),
                    )
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
