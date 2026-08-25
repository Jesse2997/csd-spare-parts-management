import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const REPORT_PATH = "/Users/jesse/Desktop/CSD管理系統/work/migration-reports/v022-dry-run.json";

test("v0.2.2 dry-run report preserves source and projected target parity", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));

  assert.deepEqual(report.source, {
    parts: 120,
    stockRows: 124,
    rmaRecords: 5996,
    shipmentRows: 98,
  });
  assert.equal(report.target.parts, 120);
  assert.equal(report.target.stockRows, 124);
  assert.equal(report.target.rmaRecords, 5996);
  assert.equal(report.target.shipmentRows, 98);
  assert.equal(report.migrationVersion, "v022-dry-run");
  assert.equal(report.mode, "dry-run");
  assert.equal(report.targetStatus, "projected-only");
  assert.equal(report.applyExecuted, false);
  assert.deepEqual(report.sourceParsingErrors, []);
  assert.equal(report.sourceWorkbookSha256, "277391e3506146a71f7ff5dde803a647f5ebf8f024606f76e349938bff8099f3");
  assert.deepEqual(report.dashboard, {
    asOfDate: "2026-07-23",
    shortagePartCount: 5,
    shortageQuantity: 137.1,
    inTransitQuantity: 989,
    pendingProductionQuantity: 0,
  });
});
