import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleCsdApi } from "../worker/csd-api.ts";

const SOURCE_WORKBOOK = "/Users/jesse/Desktop/CSD管理系統/CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx";
const SOURCE_FILENAME = "CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx";
const CONTRACT_VERSION = "csd-baseline-v022-1";
const SOURCE_SHA256 = "277391e3506146a71f7ff5dde803a647f5ebf8f024606f76e349938bff8099f3";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function migrationRequest({
  filename = SOURCE_FILENAME,
  contentType = XLSX_CONTENT_TYPE,
  contract = CONTRACT_VERSION,
  sha256 = SOURCE_SHA256,
  body,
} = {}) {
  return new Request("https://owner.csd.example/api/admin/migrations/v0.2.2", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-csd-migration-contract": contract,
      "x-csd-migration-filename": filename,
      "x-csd-migration-sha256": sha256,
    },
    body,
  });
}

function createBaselineEnv({ failBatch = false, applyThenFailBatch = false } = {}) {
  const writes = { runs: 0, batches: 0, r2Puts: 0, r2Deletes: 0 };
  const statements = [];
  const r2Objects = new Set();
  const versions = new Map();
  const baselineLocks = new Set();
  const DB = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async run() {
          writes.runs += 1;
          statements.push({ sql, values: this.values });
          if (sql.includes("INSERT INTO import_versions")) {
            versions.set(71, { status: "pending" });
            return { meta: { last_row_id: 71 } };
          }
          if (sql.includes("DELETE FROM import_versions")) versions.delete(this.values.at(-1));
          return { meta: { changes: 1 } };
        },
        async all() {
          if (sql.includes("FROM import_versions") && sql.includes("baseline_migrations")) {
            const version = versions.get(this.values[0]);
            return { results: version ? [{ status: version.status, baseline_locked: baselineLocks.has(this.values[0]) ? 1 : 0 }] : [] };
          }
          if (sql.includes("FROM baseline_migrations")) return { results: [] };
          if (sql.includes("COUNT(*) AS record_count")) return { results: [{ record_count: 0 }] };
          if (sql.includes("MAX(service_date)")) return { results: [{ as_of_date: null }] };
          if (sql.includes("FROM parts") || sql.includes("FROM rma_records") || sql.includes("FROM stock_snapshots") || sql.includes("FROM production_orders") || sql.includes("FROM import_versions")) return { results: [] };
          throw new Error(`Unexpected read: ${sql}`);
        },
      };
      return statement;
    },
    async batch(batchStatements) {
      writes.batches += 1;
      if (failBatch) throw new Error("D1 batch failed");
      statements.push(...batchStatements.map(({ sql, values }) => ({ sql, values })));
      for (const batchStatement of batchStatements) {
        if (batchStatement.sql.includes("INSERT INTO baseline_migrations")) baselineLocks.add(batchStatement.values[1]);
        if (batchStatement.sql.includes("UPDATE import_versions") && batchStatement.sql.includes("status = 'active'")) {
          versions.set(batchStatement.values.at(-1), { status: "active" });
        }
      }
      if (applyThenFailBatch) throw new Error("D1 response lost after commit");
      return batchStatements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const IMPORTS = {
    async put(key, body) {
      writes.r2Puts += 1;
      assert.match(key, /^originals\/71\/CSD_spare_parts_control_2026-07-31_v0\.2\.2\.xlsx$/);
      assert.ok(body instanceof ArrayBuffer);
      r2Objects.add(key);
    },
    async delete(key) {
      writes.r2Deletes += 1;
      r2Objects.delete(key);
    },
  };
  return { DB, IMPORTS, writes, statements, r2Objects, versions, baselineLocks };
}

function createReconciledBaselineEnv() {
  const dashboardParts = [
    ...Array.from({ length: 5 }, (_, index) => ({
      material_number: `SHORT-${index + 1}`,
      site: "CSD",
      model: null,
      pn_key: null,
      pn_key2: null,
      target_months: 6,
      safety_months: 3,
      demand_override: 0,
      safety_override: 27.42,
      active: 1,
      inbound_qty: 0,
      imported_planned_qty: 0,
      notes: null,
      updated_at: "2026-08-02T00:00:00",
    })),
    {
      material_number: "IN-TRANSIT",
      site: "CSD",
      model: null,
      pn_key: null,
      pn_key2: null,
      target_months: 6,
      safety_months: 3,
      demand_override: 0,
      safety_override: 0,
      active: 1,
      inbound_qty: 989,
      imported_planned_qty: 0,
      notes: null,
      updated_at: "2026-08-02T00:00:00",
    },
  ];
  const counts = new Map([
    ["parts", 120],
    ["stock_snapshots", 124],
    ["rma_records", 5996],
    ["shipments", 98],
  ]);
  const DB = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() {
          const countTable = this.sql.match(/SELECT COUNT\(\*\) AS record_count FROM (\w+)/)?.[1];
          if (countTable) return { results: [{ record_count: counts.get(countTable) }] };
          if (this.sql.includes("FROM baseline_migrations") && this.sql.includes("JOIN import_versions")) {
            return { results: [{ id: 71, version_code: "V260802" }] };
          }
          if (this.sql.includes("FROM parts WHERE")) return { results: dashboardParts };
          if (this.sql.includes("MAX(service_date)")) return { results: [{ as_of_date: "2026-07-23" }] };
          if (this.sql.includes("FROM rma_records WHERE material_number")) return { results: [] };
          if (this.sql.includes("FROM stock_snapshots") && this.sql.includes("GROUP BY")) return { results: [] };
          if (this.sql.includes("FROM import_versions WHERE status")) return { results: [] };
          if (this.sql.includes("FROM production_orders")) return { results: [] };
          throw new Error(`Unexpected read: ${this.sql}`);
        },
      };
    },
  };
  return { DB };
}

test("baseline migration rejects a missing contract header without touching D1 or R2", async () => {
  const env = createBaselineEnv();
  const bytes = await readFile(SOURCE_WORKBOOK);

  const response = await handleCsdApi(migrationRequest({ contract: "", body: bytes }), env);

  assert.equal(response.status, 400);
  assert.equal(env.writes.runs, 0);
  assert.equal(env.writes.batches, 0);
  assert.equal(env.writes.r2Puts, 0);
});

test("baseline migration rejects a different filename, content type, or oversized bytes before staging", async () => {
  const sourceBytes = await readFile(SOURCE_WORKBOOK);
  const invalidInputs = [
    migrationRequest({ filename: "other.xlsx", body: sourceBytes }),
    migrationRequest({ contentType: "multipart/form-data", body: sourceBytes }),
    migrationRequest({ body: new Uint8Array(512 * 1024 + 1) }),
  ];

  for (const request of invalidInputs) {
    const env = createBaselineEnv();
    const response = await handleCsdApi(request, env);

    assert.ok([400, 413, 415].includes(response.status));
    assert.equal(env.writes.runs, 0);
    assert.equal(env.writes.batches, 0);
    assert.equal(env.writes.r2Puts, 0);
  }
});

test("baseline migration publishes its exact private contract without touching D1 or R2", async () => {
  const env = createBaselineEnv();
  const response = await handleCsdApi(new Request("https://owner.csd.example/api/admin/migrations/v0.2.2/contract"), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.contractVersion, CONTRACT_VERSION);
  assert.equal(body.filename, SOURCE_FILENAME);
  assert.equal(body.maxBytes, 512 * 1024);
  assert.deepEqual(body.expectedSource, { parts: 120, stockRows: 124, rmaRecords: 5996, shipmentRows: 98 });
  assert.equal(env.writes.runs, 0);
  assert.equal(env.writes.r2Puts, 0);
});

test("baseline reconciliation identifies the fixed source and exposes the exact dashboard baseline", async () => {
  const response = await handleCsdApi(
    new Request("https://owner.csd.example/api/admin/migrations/v0.2.2/reconciliation"),
    createReconciledBaselineEnv(),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.migrationKey, "csd-v022-baseline");
  assert.equal(body.migrationVersion, "v0.2.2-baseline");
  assert.equal(body.sourceSha256, SOURCE_SHA256);
  assert.equal(body.versionCode, "V260802");
  assert.deepEqual(body.target, { parts: 120, stockRows: 124, rmaRecords: 5996, shipmentRows: 98 });
  assert.deepEqual(body.dashboard, {
    part_count: 6,
    shortage_part_count: 5,
    shortage_qty: 137.1,
    in_transit_qty: 989,
    pending_production_qty: 0,
    asOfDate: "2026-07-23",
  });
});

test("baseline migration keeps all four source collections in one staged D1 activation", async () => {
  const env = createBaselineEnv();
  const bytes = await readFile(SOURCE_WORKBOOK);

  const response = await handleCsdApi(migrationRequest({ body: bytes }), env);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body.target, { parts: 120, stockRows: 124, rmaRecords: 5996, shipmentRows: 98 });
  assert.equal(env.writes.r2Puts, 1);
  assert.equal(env.writes.batches, 1);
  assert.equal(env.r2Objects.size, 1);
  assert.ok(env.statements.some(({ sql }) => sql.includes("INSERT INTO shipments")));
  assert.ok(env.statements.some(({ sql }) => sql.includes("INSERT INTO rma_records")));
  assert.ok(env.statements.some(({ sql }) => sql.includes("INSERT INTO stock_snapshots")));
  assert.ok(env.statements.some(({ sql }) => sql.includes("INSERT INTO parts")));
  const insertedShipments = env.statements.find(({ sql }) => sql.includes("INSERT INTO shipments"));
  assert.equal(JSON.parse(insertedShipments.values.at(-1)).length, 98);
  const insertedStocks = env.statements.find(({ sql }) => sql.includes("INSERT INTO stock_snapshots"));
  const stocks = JSON.parse(insertedStocks.values.at(-1));
  assert.equal(stocks.filter(({ warehouse }) => warehouse === "CSD").length, 17);
  assert.deepEqual(stocks.find(({ material_number, warehouse }) => material_number === "EK.A2C0A.001" && warehouse === "CSD"), {
    material_number: "EK.A2C0A.001",
    warehouse: "CSD",
    bin_location: null,
    quantity: 10,
  });
  assert.ok(env.statements.some(({ sql }) => sql.includes("UPDATE import_versions") && sql.includes("status = 'active'")));
});

test("baseline migration recovers when D1 applies its activation batch and then rejects", async () => {
  const env = createBaselineEnv({ applyThenFailBatch: true });
  const bytes = await readFile(SOURCE_WORKBOOK);

  const response = await handleCsdApi(migrationRequest({ body: bytes }), env);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.version_id, 71);
  assert.equal(body.recovered, true);
  assert.deepEqual(env.versions.get(71), { status: "active" });
  assert.equal(env.baselineLocks.has(71), true);
  assert.equal(env.writes.r2Deletes, 0);
  assert.equal(env.r2Objects.size, 1);
});

test("baseline migration leaves current data untouched and deletes the staged original when D1 activation fails", async () => {
  const env = createBaselineEnv({ failBatch: true });
  const bytes = await readFile(SOURCE_WORKBOOK);

  const response = await handleCsdApi(migrationRequest({ body: bytes }), env);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.detail, /目前有效資料未變更/);
  assert.equal(env.writes.batches, 1);
  assert.equal(env.writes.r2Puts, 1);
  assert.equal(env.writes.r2Deletes, 1);
  assert.equal(env.r2Objects.size, 0);
});
