import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import { parseUpdateWorkbook } from "../worker/csd-import.ts";
import { handleCsdApi } from "../worker/csd-api.ts";

const knownParts = new Set(["P-001", "P-002"]);

function workbookBytes(sheetName, rows, options = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(book, { type: "array", bookType: "xlsx", ...options });
}

function upload(filename, bytes) {
  return new File([bytes], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function formRequest(path, fields, bytes, filename = "update.xlsx") {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set("file", upload(filename, bytes));
  return new Request(`https://csd.test${path}`, { method: "POST", body: form });
}

test("rejects inventory rows for material numbers absent from the master", async () => {
  const result = await parseUpdateWorkbook(
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "UNKNOWN", 1]]),
    "inventory",
    "full",
    knownParts,
  );

  assert.equal(result.canCommit, false);
  assert.match(result.errors[0], /未知料號/);
});

test("excludes duplicate RMA rows for incremental uploads", async () => {
  const result = await parseUpdateWorkbook(
    workbookBytes("RMA", [
      ["RMA日期", "料號", "客戶", "序號", "故障分類"],
      ["2026-08-01", "P-001", "Acme", "SN-1", "故障"],
      ["2026-08-01", "P-001", "Acme", "SN-1", "故障"],
    ]),
    "rma",
    "incremental",
    knownParts,
  );

  assert.equal(result.summary.records, 1);
  assert.equal(result.items.length, 1);
});

test("reports the exact warehouse scope for a partial inventory upload", async () => {
  const result = await parseUpdateWorkbook(
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], [" csd ", "P-001", 12]]),
    "inventory",
    "partial",
    knownParts,
  );

  assert.deepEqual(result.scope, ["CSD"]);
});

test("rejects exact duplicate inventory identities after warehouse normalization", async () => {
  const result = await parseUpdateWorkbook(
    workbookBytes("庫存快照", [
      ["倉庫", "料號", "儲位", "數量"],
      ["CSD", "P-001", "A-01", 10],
      ["csd", "P-001", "A-01", 3],
    ]),
    "inventory",
    "partial",
    knownParts,
  );

  assert.equal(result.canCommit, false);
  assert.equal(result.items.length, 1);
  assert.match(result.errors[0], /倉庫.*料號.*儲位.*重複/);
});

test("keeps case-distinct master material numbers as separate inventory identities", async () => {
  const result = await parseUpdateWorkbook(
    workbookBytes("庫存快照", [
      ["倉庫", "料號", "儲位", "數量"],
      ["CSD", "P-001", "A-01", 10],
      ["csd", "p-001", "A-01", 3],
    ]),
    "inventory",
    "partial",
    new Set(["P-001", "p-001"]),
  );

  assert.equal(result.canCommit, true);
  assert.deepEqual(result.items.map(({ material_number }) => material_number), ["P-001", "p-001"]);
});

test("rejects workbooks with more than 10,000 non-empty import rows", async () => {
  const rows = [["倉庫", "料號", "數量"]];
  for (let number = 0; number < 10_001; number += 1) rows.push(["CSD", "P-001", number + 1]);

  const result = await parseUpdateWorkbook(workbookBytes("庫存快照", rows), "inventory", "full", knownParts);

  assert.equal(result.canCommit, false);
  assert.match(result.errors[0], /10,000/);
});

test("rejects a sparse worksheet whose declared row range exceeds the import limit", async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["倉庫", "料號", "數量"]]);
  sheet["!ref"] = "A1:C1048576";
  XLSX.utils.book_append_sheet(book, sheet, "庫存快照");

  const result = await parseUpdateWorkbook(
    XLSX.write(book, { type: "array", bookType: "xlsx" }),
    "inventory",
    "full",
    knownParts,
  );

  assert.equal(result.canCommit, false);
  assert.match(result.errors[0], /10,000/);
});

test("rejects an activation snapshot whose encoded JSON payload exceeds 2 MiB", async () => {
  const rows = [["RMA日期", "料號", "客戶", "序號", "故障分類"]];
  for (let number = 0; number < 6_000; number += 1) {
    rows.push(["2026-08-01", "P-001", "Acme", `SN-${number}-${"x".repeat(400)}`, "故障"]);
  }
  const bytes = workbookBytes("RMA", rows, { compression: true });
  const env = createImportEnv();
  const preview = await handleCsdApi(formRequest("/api/data/preview", { data_type: "rma", mode: "full" }, bytes), env);
  const previewBody = await preview.json();
  const response = await handleCsdApi(formRequest("/api/data/commit", { data_type: "rma", mode: "full" }, bytes), env);
  const body = await response.json();

  assert.ok(bytes.byteLength <= 2 * 1024 * 1024);
  assert.equal(preview.status, 200);
  assert.equal(previewBody.canCommit, false);
  assert.match(previewBody.errors[0], /snapshot.*2 MiB/i);
  assert.equal(response.status, 413);
  assert.match(body.detail, /snapshot.*2 MiB/i);
  assert.equal(env.writes.runs, 0);
  assert.equal(env.writes.r2Puts, 0);
});

function createImportEnv({ existingRmas = [], failBatch = false, applyThenFailBatch = false, failReconciliation = false, failR2Put = false, failR2Delete = false, missingR2 = false } = {}) {
  const writes = { runs: 0, batches: 0, batchSizes: [], r2Puts: 0, r2Deletes: 0 };
  const statements = [];
  const activeParts = new Map();
  const activeStock = new Map();
  const versions = new Map();
  const r2Objects = new Set();
  let nextVersionId = 41;
  const DB = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          if (sql.includes("SELECT material_number FROM parts")) return { results: [...knownParts].map((material_number) => ({ material_number })) };
          if (sql.includes("SELECT service_date") && sql.includes("FROM rma_records")) return { results: existingRmas };
          if (sql.includes("FROM import_versions") && sql.includes("baseline_migrations")) {
            if (failReconciliation) throw new Error("D1 reconciliation failed");
            const version = versions.get(this.values[0]);
            return { results: version ? [{ status: version.status, baseline_locked: 0 }] : [] };
          }
          throw new Error(`Unexpected read: ${sql}`);
        },
        async run() {
          writes.runs += 1;
          statements.push({ sql, values: this.values });
          if (sql.includes("INSERT INTO import_versions")) {
            const id = nextVersionId++;
            versions.set(id, { status: "pending" });
            return { meta: { last_row_id: id } };
          }
          if (sql.includes("DELETE FROM import_versions")) versions.delete(this.values.at(-1));
          if (sql.includes("SET status = 'failed'")) versions.set(this.values.at(-1), { status: "failed" });
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(batchStatements) {
      writes.batches += 1;
      writes.batchSizes.push(batchStatements.length);
      if (failBatch) throw new Error("D1 batch failed");
      statements.push(...batchStatements.map(({ sql, values }) => ({ sql, values })));
      for (const batchStatement of batchStatements) {
        if (batchStatement.sql.includes("INSERT INTO parts")) {
          const records = JSON.parse(batchStatement.values.at(-1));
          for (const record of records) activeParts.set(record.material_number, true);
        }
        if (batchStatement.sql.includes("UPDATE parts SET active = 0")) {
          const imported = new Set(JSON.parse(batchStatement.values.at(-1)).map((record) => record.material_number));
          for (const materialNumber of activeParts.keys()) {
            if (!imported.has(materialNumber)) activeParts.set(materialNumber, false);
          }
        }
        if (batchStatement.sql.includes("DELETE FROM stock_snapshots")) {
          if (!batchStatement.sql.includes("WHERE")) activeStock.clear();
          else {
            const warehouses = new Set(batchStatement.values.map((warehouse) => String(warehouse)));
            for (const key of activeStock.keys()) {
              if (warehouses.has(key.split("|")[0])) activeStock.delete(key);
            }
          }
        }
        if (batchStatement.sql.includes("INSERT INTO stock_snapshots")) {
          const records = JSON.parse(batchStatement.values.at(-1));
          for (const record of records) {
            activeStock.set(`${record.warehouse}|${record.material_number}|${record.bin_location ?? ""}`, record.quantity);
          }
        }
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
      assert.match(key, /^originals\/\d+\/[A-Za-z0-9._-]+\.xlsx$/);
      assert.ok(body instanceof ArrayBuffer);
      r2Objects.add(key);
      if (failR2Put) throw new Error("R2 put failed");
    },
    async delete(key) {
      writes.r2Deletes += 1;
      if (failR2Delete) throw new Error("R2 delete failed");
      r2Objects.delete(key);
    },
  };
  return { DB, IMPORTS: missingR2 ? undefined : IMPORTS, writes, statements, activeParts, activeStock, versions, r2Objects };
}

test("preview validates uploads without writing D1 or R2", async () => {
  const env = createImportEnv();
  const request = formRequest(
    "/api/data/preview",
    { data_type: "inventory", mode: "full" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "UNKNOWN", 1]]),
  );

  const response = await handleCsdApi(request, env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.canCommit, false);
  assert.equal(env.writes.runs, 0);
  assert.equal(env.writes.batches, 0);
  assert.equal(env.writes.r2Puts, 0);
});

test("rejects uploads larger than 2 MiB before attempting to parse the workbook", async () => {
  const env = createImportEnv();
  const response = await handleCsdApi(formRequest(
    "/api/data/preview",
    { data_type: "inventory", mode: "full" },
    new Uint8Array(2 * 1024 * 1024 + 1).buffer,
    "too-large.xlsx",
  ), env);
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.detail, /2 MiB/);
  assert.equal(env.writes.runs, 0);
  assert.equal(env.writes.batches, 0);
  assert.equal(env.writes.r2Puts, 0);
});

test("incremental RMA preview applies the existing-record duplicate filter used by commit", async () => {
  const duplicate = { service_date: "2026-08-01", material_number: "P-001", customer: "Acme", serial_number: "SN-1", failure_classification: "故障" };
  const env = createImportEnv({ existingRmas: [duplicate] });
  const fields = { data_type: "rma", mode: "incremental" };
  const bytes = workbookBytes("RMA", [["RMA日期", "料號", "客戶", "序號", "故障分類"], ["2026-08-01", "P-001", "Acme", "SN-1", "故障"]]);
  const preview = await handleCsdApi(formRequest("/api/data/preview", fields, bytes), env);
  const previewBody = await preview.json();

  assert.equal(preview.status, 200);
  assert.equal(previewBody.summary.records, 0);
  assert.match(previewBody.warnings[0], /已存在/);
  assert.equal(env.writes.runs, 0);
  assert.equal(env.writes.r2Puts, 0);

  const commit = await handleCsdApi(formRequest("/api/data/commit", fields, bytes), env);
  const commitBody = await commit.json();

  assert.equal(commit.status, 200);
  assert.equal(commitBody.summary.records, previewBody.summary.records);
  assert.equal(commitBody.summary.stored_records, previewBody.summary.records);
  assert.deepEqual(commitBody.warnings, previewBody.warnings);
});

test("commit stores the original before one staged batch activates incremental RMA data", async () => {
  const env = createImportEnv({
    existingRmas: [{ service_date: "2026-08-01", material_number: "P-001", customer: "Acme", serial_number: "SN-OLD", failure_classification: "故障" }],
  });
  const request = formRequest(
    "/api/data/commit",
    { data_type: "rma", mode: "incremental", operator: "測試者" },
    workbookBytes("RMA", [["RMA日期", "料號", "客戶", "序號", "故障分類"], ["2026-08-02", "P-001", "Acme", "SN-2", "故障"]]),
    "rma upload.xlsx",
  );

  const response = await handleCsdApi(request, env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version_id, 41);
  assert.equal(env.writes.runs, 1);
  assert.equal(env.writes.r2Puts, 1);
  assert.equal(env.writes.batches, 1);
  assert.ok(env.statements.some(({ sql }) => sql.includes("INSERT INTO import_batches")));
  assert.ok(env.statements.some(({ sql }) => sql.includes("INSERT INTO rma_records")));
  assert.ok(env.statements.some(({ sql }) => sql.includes("UPDATE import_versions")));
});

test("a full master import deactivates material numbers omitted from its activation batch", async () => {
  const env = createImportEnv();
  const first = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "master", mode: "full" },
    workbookBytes("料號主檔", [["料號"], ["P-001"], ["P-002"]]),
  ), env);
  const second = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "master", mode: "full" },
    workbookBytes("料號主檔", [["料號"], ["P-002"]]),
  ), env);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(env.activeParts.get("P-001"), false);
  assert.equal(env.activeParts.get("P-002"), true);
  assert.ok(env.statements.some(({ sql }) => sql.includes("UPDATE parts SET active = 0")));
});

test("checks for an R2 binding before it creates a version placeholder", async () => {
  const env = createImportEnv({ missingR2: true });
  const response = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "full" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "P-001", 3]]),
  ), env);

  assert.equal(response.status, 500);
  assert.equal(env.writes.runs, 0);
  assert.equal(env.versions.size, 0);
  assert.equal(env.r2Objects.size, 0);
});

test("compensates a failed R2 put by removing its pending version and original object", async () => {
  const env = createImportEnv({ failR2Put: true });
  const response = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "full" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "P-001", 3]]),
  ), env);

  assert.equal(response.status, 500);
  assert.equal(env.writes.batches, 0);
  assert.equal(env.writes.r2Puts, 1);
  assert.equal(env.writes.r2Deletes, 1);
  assert.equal(env.versions.size, 0);
  assert.equal(env.r2Objects.size, 0);
});

test("does not activate current data when the staged D1 batch fails", async () => {
  const env = createImportEnv({ failBatch: true });
  env.activeStock.set("CSD|P-001", 8);
  const request = formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "partial" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "P-001", 3]]),
  );

  const response = await handleCsdApi(request, env);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.detail, /儲存失敗/);
  assert.equal(env.writes.batches, 1);
  assert.equal(env.statements.some(({ sql }) => sql.includes("DELETE FROM stock_snapshots")), false);
  assert.equal(env.writes.r2Puts, 1);
  assert.equal(env.writes.r2Deletes, 1);
  assert.equal(env.versions.size, 0);
  assert.equal(env.r2Objects.size, 0);
  assert.equal(env.activeStock.get("CSD|P-001"), 8);
});

test("recovers a committed import when D1 applies the activation batch and then rejects", async () => {
  const env = createImportEnv({ applyThenFailBatch: true });
  const response = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "partial" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "P-001", 3]]),
  ), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version_id, 41);
  assert.equal(body.recovered, true);
  assert.deepEqual(env.versions.get(41), { status: "active" });
  assert.equal(env.writes.r2Deletes, 0);
  assert.equal(env.r2Objects.size, 1);
});

test("retains the pending version and original when D1 activation cannot be reconciled", async () => {
  const env = createImportEnv({ failBatch: true, failReconciliation: true });
  const response = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "partial" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "P-001", 3]]),
  ), env);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.detail, /無法確認.*保留/);
  assert.deepEqual(env.versions.get(41), { status: "pending" });
  assert.equal(env.writes.r2Deletes, 0);
  assert.equal(env.r2Objects.size, 1);
});

test("a lowercase partial CSD upload replaces the canonical CSD warehouse without double-counting", async () => {
  const env = createImportEnv();
  env.activeStock.set("CSD|P-001|", 10);

  const response = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "partial" },
    workbookBytes("庫存快照", [["倉庫", "料號", "儲位", "數量"], ["csd", "P-001", "", 3]]),
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual([...env.activeStock.entries()], [["CSD|P-001|", 3]]);
  assert.equal([...env.activeStock.values()].reduce((total, quantity) => total + quantity, 0), 3);
});

test("hides a failed version with its object key when R2 compensation cannot delete the original", async () => {
  const env = createImportEnv({ failBatch: true, failR2Delete: true });
  const response = await handleCsdApi(formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "partial" },
    workbookBytes("庫存快照", [["倉庫", "料號", "數量"], ["CSD", "P-001", 3]]),
  ), env);

  assert.equal(response.status, 500);
  assert.equal(env.writes.r2Deletes, 1);
  assert.equal(env.r2Objects.size, 1);
  assert.deepEqual(env.versions.get(41), { status: "failed" });
});

test("activates a normal-sized inventory snapshot in one atomic batch", async () => {
  const env = createImportEnv();
  const rows = [["倉庫", "料號", "儲位", "數量"]];
  for (let number = 0; number < 105; number += 1) rows.push(["CSD", "P-001", `BIN-${number + 1}`, number + 1]);
  const request = formRequest(
    "/api/data/commit",
    { data_type: "inventory", mode: "full" },
    workbookBytes("庫存快照", rows),
  );

  const response = await handleCsdApi(request, env);
  const body = await response.json();
  const insertedRecords = env.statements.find(({ sql }) => sql.includes("INSERT INTO stock_snapshots"));

  assert.equal(response.status, 200);
  assert.equal(body.summary.stored_records, 105);
  assert.equal(env.writes.batches, 1);
  assert.ok(insertedRecords);
  assert.equal(JSON.parse(insertedRecords.values.at(-1)).length, 105);
});

function createVersionRouteEnv({ versionOverrides = {}, exportCounts = { parts: 1, stocks: 1, rmas: 1 } } = {}) {
  const batches = [];
  const calls = [];
  const version = {
    id: 7,
    data_type: "inventory",
    import_mode: "partial",
    filename: "csd-csd-only.xlsx",
    stored_object_key: "originals/7/csd-csd-only.xlsx",
    created_at: "2026-08-02T00:00:00",
    created_by: "測試者",
    summary_json: "{\"records\":1}",
    warnings_json: "[]",
    errors_json: "[]",
    payload_json: "[{\"material_number\":\"P-001\",\"warehouse\":\"CSD\",\"bin_location\":null,\"quantity\":9}]",
    scope_json: "[\"CSD\"]",
    restored_from_id: null,
    batch_id: null,
    version_code: "V260802",
    status: "active",
    ...versionOverrides,
  };
  return {
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) { this.values = values; return this; },
          async all() {
            calls.push({ sql, values: this.values });
            if (sql.includes("COUNT(*) AS record_count")) {
              if (sql.includes("FROM parts")) return { results: [{ record_count: exportCounts.parts }] };
              if (sql.includes("FROM stock_snapshots")) return { results: [{ record_count: exportCounts.stocks }] };
              if (sql.includes("FROM rma_records")) return { results: [{ record_count: exportCounts.rmas }] };
            }
            if (sql.includes("FROM import_versions")) return { results: [version] };
            if (sql.includes("FROM parts")) return { results: [{ material_number: "P-001", site: "CSD", model: "Widget", pn_key: null, pn_key2: null, inbound_qty: 0, imported_planned_qty: 0, notes: null }] };
            if (sql.includes("FROM stock_snapshots")) return { results: [{ material_number: "P-001", warehouse: "CSD", bin_location: null, quantity: 5 }] };
            if (sql.includes("FROM rma_records")) return { results: [{ service_date: "2026-08-01", material_number: "P-001", customer: null, region: null, product_type: null, model_customer: null, model: null, serial_number: null, failure_classification: null }] };
            throw new Error(`Unexpected read: ${sql}`);
          },
          async run() { return { meta: { last_row_id: 99, changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements) { batches.push(statements); return statements.map(() => ({ meta: { changes: 1 } })); },
    },
    batches,
    calls,
  };
}

test("restoring an inventory version replaces only its saved warehouse scope", async () => {
  const env = createVersionRouteEnv();
  const response = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/restore", { method: "POST", body: new FormData() }), env);

  assert.equal(response.status, 200);
  assert.equal(env.batches.length, 1);
  const statements = env.batches[0];
  const deleteStocks = statements.find((statement) => statement.sql.includes("DELETE FROM stock_snapshots"));
  assert.ok(deleteStocks);
  assert.deepEqual(deleteStocks.values, ["CSD"]);
  assert.equal(statements.some((statement) => statement.sql.includes("production_orders") || statement.sql.includes("target_months")), false);
});

test("restoring a legacy inventory version aggregates duplicate normalized identities", async () => {
  const env = createVersionRouteEnv({
    versionOverrides: {
      payload_json: JSON.stringify([
        { material_number: "P-001", warehouse: "CSD", bin_location: null, quantity: 10 },
        { material_number: "P-001", warehouse: " csd ", bin_location: null, quantity: 3 },
      ]),
      scope_json: "[\"csd\"]",
    },
  });

  const response = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/restore", { method: "POST", body: new FormData() }), env);
  const statements = env.batches[0];
  const insertStocks = statements.find((statement) => statement.sql.includes("INSERT INTO stock_snapshots"));
  const restoredVersion = statements.find((statement) => statement.sql.includes("INSERT INTO import_versions"));

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(insertStocks.values.at(-1)), [
    { material_number: "P-001", warehouse: "CSD", bin_location: null, quantity: 13 },
  ]);
  assert.deepEqual(JSON.parse(restoredVersion.values[8]), [
    { material_number: "P-001", warehouse: "CSD", bin_location: null, quantity: 13 },
  ]);
  assert.deepEqual(JSON.parse(restoredVersion.values[9]), ["CSD"]);
});

test("restoring a full master version preserves manual settings and deactivates omitted material numbers", async () => {
  const payload = [{
    material_number: "P-001", site: "CSD", model: "Widget", pn_key: null, pn_key2: null,
    target_months: 6, safety_months: 3, demand_override: null, safety_override: null, active: true,
    inbound_qty: 4, imported_planned_qty: 2, notes: "匯入備註", updated_at: "",
  }];
  const env = createVersionRouteEnv({
    versionOverrides: {
      data_type: "master",
      import_mode: "full",
      filename: "master-v1.xlsx",
      payload_json: JSON.stringify(payload),
      scope_json: "[]",
    },
  });

  const response = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/restore", { method: "POST", body: new FormData() }), env);
  const statements = env.batches[0];
  const upsert = statements.find((statement) => statement.sql.includes("INSERT INTO parts"));
  const deactivate = statements.find((statement) => statement.sql.includes("UPDATE parts SET active = 0"));

  assert.equal(response.status, 200);
  assert.ok(upsert);
  assert.doesNotMatch(upsert.sql, /target_months\s*=/);
  assert.doesNotMatch(upsert.sql, /safety_months\s*=/);
  assert.doesNotMatch(upsert.sql, /demand_override\s*=/);
  assert.doesNotMatch(upsert.sql, /safety_override\s*=/);
  assert.doesNotMatch(upsert.sql, /notes\s*=/);
  assert.ok(deactivate);
  assert.match(deactivate.sql, /material_number NOT IN/);
  assert.equal(deactivate.values.at(-1), JSON.stringify(payload));
});

test("restoring a restored master preserves its full coverage", async () => {
  const payload = [{
    material_number: "P-001", site: "CSD", model: "Widget", pn_key: null, pn_key2: null,
    target_months: 6, safety_months: 3, demand_override: null, safety_override: null, active: true,
    inbound_qty: 4, imported_planned_qty: 2, notes: "匯入備註", updated_at: "",
  }];
  const env = createVersionRouteEnv({
    versionOverrides: {
      data_type: "master",
      import_mode: "restore",
      filename: "restored-master-v1.xlsx",
      payload_json: JSON.stringify(payload),
      scope_json: "[]",
      restored_from_id: 6,
    },
  });

  const response = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/restore", { method: "POST", body: new FormData() }), env);
  const statements = env.batches[0];
  const deactivate = statements.find((statement) => statement.sql.includes("UPDATE parts SET active = 0"));
  const restoredVersion = statements.find((statement) => statement.sql.includes("INSERT INTO import_versions"));

  assert.equal(response.status, 200);
  assert.ok(deactivate);
  assert.ok(restoredVersion);
  assert.equal(restoredVersion.values[1], "full");
});

test("restoring empty inventory only clears stock for a full version", async () => {
  const emptyPartial = createVersionRouteEnv({
    versionOverrides: { import_mode: "partial", payload_json: "[]", scope_json: "[]" },
  });
  const partialResponse = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/restore", { method: "POST", body: new FormData() }), emptyPartial);
  const partialStocks = emptyPartial.batches[0].filter((statement) => statement.sql.includes("stock_snapshots"));

  const emptyFull = createVersionRouteEnv({
    versionOverrides: { import_mode: "full", payload_json: "[]", scope_json: "[]" },
  });
  const fullResponse = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/restore", { method: "POST", body: new FormData() }), emptyFull);
  const fullDelete = emptyFull.batches[0].find((statement) => statement.sql === "DELETE FROM stock_snapshots");

  assert.equal(partialResponse.status, 200);
  assert.equal(partialStocks.length, 0);
  assert.equal(fullResponse.status, 200);
  assert.ok(fullDelete);
});

test("exports the current master, inventory, and RMA workbooks as an attachment ZIP", async () => {
  const env = createVersionRouteEnv();
  const response = await handleCsdApi(new Request("https://csd.test/api/data/export/current.zip"), env);
  const archiveText = new TextDecoder().decode(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(archiveText, /csd-current-master\.xlsx/);
  assert.match(archiveText, /csd-current-inventory\.xlsx/);
  assert.match(archiveText, /csd-current-rma\.xlsx/);
});

test("rejects an oversized current-data export before loading workbook rows", async () => {
  const env = createVersionRouteEnv({ exportCounts: { parts: 10_001, stocks: 0, rmas: 0 } });
  const response = await handleCsdApi(new Request("https://csd.test/api/data/export/current.zip"), env);
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.detail, /匯出.*上限/);
  assert.ok(env.calls.some(({ sql }) => sql.includes("COUNT(*) AS record_count")));
  assert.equal(env.calls.some(({ sql }) => sql.includes("SELECT material_number") && sql.includes("FROM parts")), false);
});

test("filters data versions by data type and search term", async () => {
  const env = createVersionRouteEnv();
  const response = await handleCsdApi(new Request("https://csd.test/api/data/versions?data_type=inventory&search=csd"), env);
  const query = env.calls.find(({ sql }) => sql.includes("FROM import_versions"));

  assert.equal(response.status, 200);
  assert.ok(query);
  assert.match(query.sql, /data_type = \?/);
  assert.match(query.sql, /filename LIKE \?/);
  assert.deepEqual(query.values, ["inventory", "%csd%", "%csd%", "%csd%", 500]);
});

test("downloads an original only through the active version's saved R2 object key", async () => {
  const env = createVersionRouteEnv();
  const reads = [];
  env.IMPORTS = {
    async get(key) {
      reads.push(key);
      return { body: new Blob(["original workbook"]).stream(), httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } };
    },
  };

  const response = await handleCsdApi(new Request("https://csd.test/api/data/versions/7/file"), env);

  assert.equal(response.status, 200);
  assert.deepEqual(reads, ["originals/7/csd-csd-only.xlsx"]);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="csd-csd-only.xlsx"');
  assert.equal(await response.text(), "original workbook");
});
