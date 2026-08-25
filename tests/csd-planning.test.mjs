import assert from "node:assert/strict";
import test from "node:test";

import {
  availableCsd,
  monthlyDemand,
  planningStockLevels,
  shortageQty,
} from "../worker/csd-data.ts";
import { handleCsdApi } from "../worker/csd-api.ts";

test("calculates weighted monthly demand from all RMA windows", () => {
  assert.equal(
    monthlyDemand({ rma1m: 24, rma3m: 135, rma6m: 290, rma12m: 626 }),
    37.98,
  );
});

test("calculates planning stock and shortage from full-precision intermediates", () => {
  assert.deepEqual(
    planningStockLevels({
      rma1m: 24,
      rma3m: 135,
      rma6m: 290,
      rma12m: 626,
      targetMonths: 6,
      safetyMonths: 1,
      csdStock: 37.976,
      inboundQty: 0,
      pendingProduction: 0,
    }),
    {
      monthlyDemand: 37.98,
      targetStock: 227.9,
      safetyStock: 37.98,
      availableCsd: 37.98,
      shortageQty: 0.01,
    },
  );
});

test("keeps zero CSD supply at the stock boundary", () => {
  assert.equal(
    availableCsd({ csdStock: 0, inboundQty: 0, pendingProduction: 0 }),
    0,
  );
});

test("reports the full safety-stock deficit when nothing is available", () => {
  assert.equal(shortageQty({ safetyStock: 113.95, availableCsd: 0 }), 113.95);
});

const fixtureParts = Array.from({ length: 9 }, (_, index) => {
  const number = index + 1;
  return {
    material_number: `P-${String(number).padStart(3, "0")}`,
    site: number === 1 ? "CSD-A" : "CSD-B",
    model: number === 1 ? "Widget" : `Model ${number}`,
    pn_key: null,
    pn_key2: null,
    target_months: 2,
    safety_months: 1,
    demand_override: null,
    safety_override: null,
    active: 1,
    inbound_qty: 0,
    imported_planned_qty: 0,
    notes: null,
    updated_at: "2026-08-01T00:00:00",
  };
});

const fixtureRmaWindows = fixtureParts.map((part, index) => {
  const demand = index + 1;
  return {
    material_number: part.material_number,
    rma_1m: demand,
    rma_3m: demand * 3,
    rma_6m: demand * 6,
    rma_12m: demand * 12,
  };
});

function createFakeEnv({ parts = fixtureParts } = {}) {
  const calls = [];
  const resultFor = (sql, values) => {
    if (sql.includes("FROM parts")) {
      if (values.includes("%Widget%") && values.includes("CSD-A")) {
        return parts.filter((part) => part.material_number === "P-001");
      }
      return parts;
    }
    if (sql.includes("MAX(service_date)")) return [{ as_of_date: "2026-08-01" }];
    if (sql.includes("FROM rma_records")) return fixtureRmaWindows;
    if (sql.includes("FROM stock_snapshots")) {
      return [{ material_number: "P-001", warehouse: "Overseas", quantity: 100 }];
    }
    if (sql.includes("FROM production_orders") && sql.includes("GROUP BY material_number")) return [];
    if (sql.includes("FROM import_versions")) {
      return values[0] === "active"
        ? [{ filename: "baseline.xlsx", created_at: "2026-08-01T00:00:00", data_type: "master", version_code: "V260801" }]
        : [{ filename: "failed-upload.xlsx", created_at: "2026-08-02T00:00:00", data_type: "inventory", version_code: "V260802" }];
    }
    if (sql.includes("FROM production_orders")) return [];
    throw new Error(`Unexpected D1 query: ${sql}`);
  };

  return {
    DB: {
      prepare(sql) {
        let values = [];
        return {
          bind(...nextValues) {
            values = nextValues;
            return this;
          },
          async all() {
            calls.push({ sql, values });
            return { results: resultFor(sql, values) };
          },
        };
      },
    },
    calls,
  };
}

function createProductionMutationEnv({ partRows = [], orderRows = [] } = {}) {
  const calls = [];
  const runs = [];
  return {
    DB: {
      prepare(sql) {
        let values = [];
        return {
          bind(...nextValues) {
            values = nextValues;
            return this;
          },
          async all() {
            calls.push({ sql, values });
            if (sql.includes("FROM parts")) return { results: partRows };
            if (sql.includes("FROM production_orders")) return { results: orderRows };
            throw new Error(`Unexpected D1 read: ${sql}`);
          },
          async run() {
            runs.push({ sql, values });
            return { meta: { last_row_id: 42, changes: 1 } };
          },
        };
      },
    },
    calls,
    runs,
  };
}

test("serves the CSD health check without falling through to another runtime", async () => {
  const fakeEnv = createFakeEnv();
  const response = await handleCsdApi(new Request("https://csd.test/api/health"), fakeEnv);

  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(fakeEnv.calls.length, 0);
});

test("returns dashboard totals and the eight highest-priority D1 planning rows", async () => {
  const fakeEnv = createFakeEnv();
  const response = await handleCsdApi(new Request("https://csd.test/api/dashboard"), fakeEnv);
  const body = await response.json();
  const expectedRows = fixtureParts
    .map((part, index) => {
      const demand = index + 1;
      const levels = planningStockLevels({
        rma1m: demand,
        rma3m: demand * 3,
        rma6m: demand * 6,
        rma12m: demand * 12,
        targetMonths: 2,
        safetyMonths: 1,
        csdStock: 0,
        inboundQty: 0,
        pendingProduction: 0,
      });
      return { material_number: part.material_number, ...levels };
    })
    .sort((left, right) => right.shortageQty - left.shortageQty);

  assert.deepEqual(body.metrics, {
    part_count: 9,
    shortage_part_count: 9,
    shortage_qty: 45,
    in_transit_qty: 0,
    pending_production_qty: 0,
  });
  assert.deepEqual(
    body.priority_parts.map(({ material_number, monthly_demand, target_stock, safety_stock, available_csd, shortage_qty }) => ({
      material_number,
      monthlyDemand: monthly_demand,
      targetStock: target_stock,
      safetyStock: safety_stock,
      availableCsd: available_csd,
      shortageQty: shortage_qty,
    })),
    expectedRows.slice(0, 8),
  );
  assert.equal(body.priority_parts.at(-1).material_number, "P-002");
  assert.equal(body.recent_import.filename, "baseline.xlsx");
});

test("binds parts filters and keeps overseas stock out of CSD availability", async () => {
  const fakeEnv = createFakeEnv();
  const response = await handleCsdApi(
    new Request("https://csd.test/api/parts?search=Widget&site=CSD-A&only_shortage=true"),
    fakeEnv,
  );
  const body = await response.json();

  assert.deepEqual(body.sites, ["CSD-A"]);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].material_number, "P-001");
  assert.equal(body.items[0].csd_stock, 0);
  assert.equal(body.items[0].overseas_stock, 100);
  assert.equal(body.items[0].available_csd, 0);
  assert.equal(body.items[0].shortage_qty, 1);
  assert.ok(fakeEnv.calls.some(({ sql, values }) => sql.includes("LIKE ?") && values.includes("%Widget%")));
});

test("exports the legacy shortage CSV columns and neutralizes spreadsheet formulas", async () => {
  const formulaParts = ["=P-001", "+P-002", "-P-003", "@P-004"].map((material_number) => ({
    ...fixtureParts[0],
    material_number,
    site: "CSD-A",
    model: "Widget",
    demand_override: 1,
  }));
  const response = await handleCsdApi(new Request("https://csd.test/api/export/shortages.csv"), createFakeEnv({ parts: formulaParts }));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body.split("\r\n")[0], "料號,Site,機種,1M RMA,3M RMA,6M RMA,12M RMA,每月需求,CSD庫存,海外庫存,在途,待投產,安全庫存,缺料量,建議生產量");
  for (const materialNumber of formulaParts.map((part) => part.material_number)) {
    assert.match(body, new RegExp(`'${materialNumber.replace(/[+]/g, "\\+")}`));
  }
});

test("rejects a new production order whose material number is unknown", async () => {
  const env = createProductionMutationEnv();
  const response = await handleCsdApi(new Request("https://csd.test/api/production-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ material_number: "UNKNOWN", suggested_qty: 5, status: "草稿" }),
  }), env);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { detail: "找不到料號" });
  assert.equal(env.runs.some(({ sql }) => sql.includes("INSERT INTO production_orders")), false);
});

test("PATCH production order merges omitted fields before validating and saving", async () => {
  const existing = {
    id: 7,
    material_number: "P-001",
    suggested_qty: 12,
    confirmed_qty: 9,
    expected_date: "2026-09-01",
    status: "已提出",
    notes: "原始備註",
    created_at: "2026-08-01T00:00:00",
    updated_at: "2026-08-01T00:00:00",
    deleted_at: null,
    deleted_by: null,
  };
  const env = createProductionMutationEnv({ orderRows: [existing] });
  const response = await handleCsdApi(new Request("https://csd.test/api/production-orders/7", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes: "更新備註" }),
  }), env);
  const update = env.runs.find(({ sql }) => sql.includes("UPDATE production_orders"));

  assert.equal(response.status, 200);
  assert.ok(env.calls.some(({ sql }) => sql.includes("FROM production_orders") && sql.includes("WHERE id = ?")));
  assert.ok(update);
  assert.deepEqual(update.values.slice(0, 5), [12, 9, "已提出", "2026-09-01", "更新備註"]);
});

test("returns a Traditional-Chinese JSON 404 for an unknown API route", async () => {
  const response = await handleCsdApi(new Request("https://csd.test/api/unknown"), createFakeEnv());

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { detail: "找不到 API" });
});
