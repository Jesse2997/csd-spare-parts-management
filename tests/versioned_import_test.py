"""Smoke test for versioned RMA and inventory imports without touching local data."""

import asyncio
import io
import sys
import tempfile
from pathlib import Path

from openpyxl import Workbook
from starlette.datastructures import UploadFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backend.main as csd


def workbook(sheet: str, headers: list[str], rows: list[list[object]]) -> bytes:
    book = Workbook()
    page = book.active
    page.title = sheet
    page.append(headers)
    for row in rows:
        page.append(row)
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def upload(filename: str, content: bytes) -> UploadFile:
    return UploadFile(filename=filename, file=io.BytesIO(content))


async def run() -> None:
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        csd.DATA_DIR = root / "data"
        csd.DB_PATH = csd.DATA_DIR / "csd.db"
        csd.ORIGINALS_DIR = csd.DATA_DIR / "originals"
        csd.init_db()

        master = workbook("料號主檔", ["料號", "Site"], [["P-001", "CSD"]])
        preview = await csd.preview_data(data_type="master", mode="full", file=upload("master.xlsx", master))
        assert preview["can_commit"]
        master_result = await csd.commit_data(data_type="master", mode="full", operator="測試員", file=upload("master.xlsx", master))
        versions = csd.list_versions()["items"]
        assert versions[0]["version_code"].startswith("V") and len(versions[0]["version_code"]) == 7
        assert csd.download_version_data(master_result["version_id"]).status_code == 200

        full_stock = workbook("庫存快照", ["倉庫", "料號", "數量"], [["CSD", "P-001", 2], ["海外", "P-001", 9]])
        first_stock = await csd.commit_data(data_type="inventory", mode="full", operator="測試員", file=upload("stock.xlsx", full_stock))
        partial_stock = workbook("庫存快照", ["倉庫", "料號", "數量"], [["CSD", "P-001", 7]])
        await csd.commit_data(data_type="inventory", mode="partial", operator="測試員", file=upload("csd-stock.xlsx", partial_stock))
        part = csd.list_parts()["items"][0]
        assert part["csd_stock"] == 7 and part["overseas_stock"] == 9

        csd.restore_version(first_stock["version_id"], operator="測試員")
        restored = csd.list_parts()["items"][0]
        assert restored["csd_stock"] == 2 and restored["overseas_stock"] == 9

        rma = workbook("RMA", ["RMA日期", "料號", "客戶", "序號", "故障分類"], [["2026-07-20", "P-001", "A", "SN1", "Fail"]])
        await csd.commit_data(data_type="rma", mode="incremental", operator="測試員", file=upload("rma.xlsx", rma))
        duplicated = await csd.commit_data(data_type="rma", mode="incremental", operator="測試員", file=upload("rma-again.xlsx", rma))
        assert duplicated["summary"]["stored_records"] == 1
        assert csd.list_parts()["items"][0]["rma_1m"] == 1

        invalid = workbook("庫存快照", ["倉庫", "料號", "數量"], [["CSD", "UNKNOWN", 1]])
        blocked = await csd.preview_data(data_type="inventory", mode="full", file=upload("invalid.xlsx", invalid))
        assert not blocked["can_commit"] and blocked["errors"]

        assert csd.download_template("rma").status_code == 200
        assert csd.export_current_data().status_code == 200

        draft = csd.create_production_order(csd.ProductionInput(material_number="P-001", suggested_qty=3, status="草稿", notes="先確認排程"))
        assert csd.production_orders()[0]["notes"] == "先確認排程"
        try:
            csd.patch_production_order(draft["id"], csd.ProductionPatch(status="已提出", notes="已通知工廠"))
            raise AssertionError("non-draft status without date must be rejected")
        except csd.HTTPException as exc:
            assert exc.status_code == 400
        csd.patch_production_order(draft["id"], csd.ProductionPatch(status="已提出", expected_date="2026-08-01", notes="已通知工廠"))
        active = csd.production_orders()[0]
        assert active["notes"] == "[2026-08-01] 已通知工廠"
        csd.delete_production_order(draft["id"])
        assert not csd.production_orders() and len(csd.deleted_production_orders()) == 1
        csd.restore_production_order(draft["id"])
        assert len(csd.production_orders()) == 1


if __name__ == "__main__":
    asyncio.run(run())
    print("versioned import test passed")
