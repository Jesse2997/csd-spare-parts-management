import type { PartRecord, PlanningRow, ProductionOrder, RmaRecord } from "./csd-types.ts";

export type DemandWindows = {
  rma1m: number;
  rma3m: number;
  rma6m: number;
  rma12m: number;
};

export type SupplyInputs = {
  csdStock: number;
  inboundQty: number;
  pendingProduction: number;
};

export type PlanningStockLevelInputs = DemandWindows & SupplyInputs & {
  targetMonths: number;
  safetyMonths: number;
};

const roundPublicValue = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const roundPriorityScore = (value: number) => Math.round((value + Number.EPSILON) * 1_000) / 1_000;

const weightedMonthlyDemand = ({ rma1m, rma3m, rma6m, rma12m }: DemandWindows): number =>
  rma1m * 0.4 + (rma3m / 3) * 0.3 + (rma6m / 6) * 0.2 + (rma12m / 12) * 0.1;

export function monthlyDemand({ rma1m, rma3m, rma6m, rma12m }: DemandWindows): number {
  return roundPublicValue(weightedMonthlyDemand({ rma1m, rma3m, rma6m, rma12m }));
}

export function planningStockLevels({
  targetMonths,
  safetyMonths,
  csdStock,
  inboundQty,
  pendingProduction,
  ...demandWindows
}: PlanningStockLevelInputs): {
  monthlyDemand: number;
  targetStock: number;
  safetyStock: number;
  availableCsd: number;
  shortageQty: number;
} {
  const demand = weightedMonthlyDemand(demandWindows);
  const targetStock = demand * targetMonths;
  const safetyStock = demand * safetyMonths;
  const availableCsd = csdStock + inboundQty + pendingProduction;
  return {
    monthlyDemand: roundPublicValue(demand),
    targetStock: roundPublicValue(targetStock),
    safetyStock: roundPublicValue(safetyStock),
    availableCsd: roundPublicValue(availableCsd),
    shortageQty: roundPublicValue(Math.max(0, safetyStock - availableCsd)),
  };
}

export function availableCsd({ csdStock, inboundQty, pendingProduction }: SupplyInputs): number {
  return roundPublicValue(csdStock + inboundQty + pendingProduction);
}

export function shortageQty({ safetyStock, availableCsd }: { safetyStock: number; availableCsd: number }): number {
  return roundPublicValue(Math.max(0, safetyStock - availableCsd));
}

export type CsdDataEnv = {
  DB: D1Database;
};

type D1Part = Omit<PartRecord, "active"> & { active: number | boolean };
type RmaWindow = {
  material_number: string;
  rma_1m: number | null;
  rma_3m: number | null;
  rma_6m: number | null;
  rma_12m: number | null;
};
type StockTotal = { material_number: string; warehouse: string; quantity: number | null };
type PendingProduction = { material_number: string; pending_production: number | null };

const ACTIVE_PART_LIMIT = 500;

async function readRows<T>(env: CsdDataEnv, sql: string, values: unknown[] = []): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...values).all<T>();
  return result.results ?? [];
}

export async function getKnownPartNumbers(env: CsdDataEnv): Promise<Set<string>> {
  const rows = await readRows<{ material_number: string }>(env, "SELECT material_number FROM parts");
  return new Set(rows.map((row) => row.material_number));
}

export async function getCurrentRmaRecords(env: CsdDataEnv): Promise<RmaRecord[]> {
  return readRows<RmaRecord>(
    env,
    `SELECT service_date, customer, region, product_type, model_customer, model,
      serial_number, failure_classification, material_number FROM rma_records ORDER BY id`,
  );
}

function monthFloor(asOfDate: string, months: number): string {
  const [yearText, monthText] = asOfDate.slice(0, 10).split("-");
  let year = Number(yearText);
  let month = Number(monthText) - months;
  while (month <= 0) {
    year -= 1;
    month += 12;
  }
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function numberOrZero(value: number | null | undefined): number {
  return Number(value ?? 0);
}

export type PlanningFilters = {
  search?: string;
  site?: string;
  onlyShortage?: boolean;
};

export async function getPlanningRows(env: CsdDataEnv, filters: PlanningFilters = {}): Promise<PlanningRow[]> {
  const clauses = ["active = ?"];
  const partValues: unknown[] = [1];
  if (filters.search?.trim()) {
    clauses.push("(material_number LIKE ? COLLATE NOCASE OR site LIKE ? COLLATE NOCASE OR model LIKE ? COLLATE NOCASE)");
    const search = `%${filters.search.trim()}%`;
    partValues.push(search, search, search);
  }
  if (filters.site?.trim()) {
    clauses.push("site = ?");
    partValues.push(filters.site.trim());
  }
  partValues.push(ACTIVE_PART_LIMIT);

  const parts = await readRows<D1Part>(
    env,
    `SELECT material_number, site, model, pn_key, pn_key2, target_months, safety_months,
      demand_override, safety_override, active, inbound_qty, imported_planned_qty, notes, updated_at
    FROM parts WHERE ${clauses.join(" AND ")} ORDER BY site, material_number LIMIT ?`,
    partValues,
  );
  const latestRma = await readRows<{ as_of_date: string | null }>(
    env,
    "SELECT MAX(service_date) AS as_of_date FROM rma_records",
  );
  const asOfDate = latestRma[0]?.as_of_date ?? new Date().toISOString().slice(0, 10);
  const [rmaWindows, stockTotals, pendingProduction] = await Promise.all([
    readRows<RmaWindow>(
      env,
      `SELECT material_number,
        COALESCE(SUM(CASE WHEN service_date >= ? THEN 1 ELSE 0 END), 0) AS rma_1m,
        COALESCE(SUM(CASE WHEN service_date >= ? THEN 1 ELSE 0 END), 0) AS rma_3m,
        COALESCE(SUM(CASE WHEN service_date >= ? THEN 1 ELSE 0 END), 0) AS rma_6m,
        COALESCE(SUM(CASE WHEN service_date >= ? THEN 1 ELSE 0 END), 0) AS rma_12m
      FROM rma_records WHERE material_number IS NOT NULL GROUP BY material_number`,
      [monthFloor(asOfDate, 1), monthFloor(asOfDate, 3), monthFloor(asOfDate, 6), monthFloor(asOfDate, 12)],
    ),
    readRows<StockTotal>(
      env,
      "SELECT material_number, UPPER(TRIM(warehouse)) AS warehouse, SUM(quantity) AS quantity FROM stock_snapshots GROUP BY material_number, UPPER(TRIM(warehouse))",
    ),
    readRows<PendingProduction>(
      env,
      `SELECT material_number, COALESCE(SUM(COALESCE(confirmed_qty, suggested_qty)), 0) AS pending_production
      FROM production_orders WHERE deleted_at IS NULL AND status IN (?, ?) GROUP BY material_number`,
      ["已提出", "生產中"],
    ),
  ]);

  const windowsByPart = new Map(rmaWindows.map((row) => [row.material_number, row]));
  const stockByPart = new Map<string, { csd: number; overseas: number }>();
  for (const row of stockTotals) {
    const current = stockByPart.get(row.material_number) ?? { csd: 0, overseas: 0 };
    if (row.warehouse.toUpperCase().startsWith("CSD")) current.csd += numberOrZero(row.quantity);
    else current.overseas += numberOrZero(row.quantity);
    stockByPart.set(row.material_number, current);
  }
  const pendingByPart = new Map(pendingProduction.map((row) => [row.material_number, numberOrZero(row.pending_production)]));

  const rows = parts.map((part): PlanningRow => {
    const windows = windowsByPart.get(part.material_number);
    const rma1m = numberOrZero(windows?.rma_1m);
    const rma3m = numberOrZero(windows?.rma_3m);
    const rma6m = numberOrZero(windows?.rma_6m);
    const rma12m = numberOrZero(windows?.rma_12m);
    const stock = stockByPart.get(part.material_number) ?? { csd: 0, overseas: 0 };
    const inboundQty = numberOrZero(part.inbound_qty);
    const pending = numberOrZero(part.imported_planned_qty) + (pendingByPart.get(part.material_number) ?? 0);
    const base = planningStockLevels({
      rma1m,
      rma3m,
      rma6m,
      rma12m,
      targetMonths: numberOrZero(part.target_months),
      safetyMonths: numberOrZero(part.safety_months),
      csdStock: stock.csd,
      inboundQty,
      pendingProduction: pending,
    });
    const demand = part.demand_override === null ? weightedMonthlyDemand({ rma1m, rma3m, rma6m, rma12m }) : numberOrZero(part.demand_override);
    const target = demand * numberOrZero(part.target_months);
    const safety = part.safety_override === null ? demand * numberOrZero(part.safety_months) : numberOrZero(part.safety_override);
    const available = stock.csd + inboundQty + pending;
    const shortage = Math.max(0, safety - available);
    const suggested = Math.max(0, target - available);
    const usesDefaultDemand = part.demand_override === null && part.safety_override === null;

    return {
      ...part,
      active: Boolean(part.active),
      rma_1m: rma1m,
      rma_3m: rma3m,
      rma_6m: rma6m,
      rma_12m: rma12m,
      as_of_date: asOfDate,
      monthly_demand: usesDefaultDemand ? base.monthlyDemand : roundPublicValue(demand),
      target_stock: usesDefaultDemand ? base.targetStock : roundPublicValue(target),
      safety_stock: usesDefaultDemand ? base.safetyStock : roundPublicValue(safety),
      csd_stock: roundPublicValue(stock.csd),
      overseas_stock: roundPublicValue(stock.overseas),
      in_transit: roundPublicValue(inboundQty),
      pending_production: roundPublicValue(pending),
      available_csd: usesDefaultDemand ? base.availableCsd : roundPublicValue(available),
      shortage_qty: usesDefaultDemand ? base.shortageQty : roundPublicValue(shortage),
      suggested_production: roundPublicValue(suggested),
      priority_score: roundPriorityScore(safety ? shortage / safety : 0),
    };
  });

  return rows
    .filter((row) => !filters.onlyShortage || row.shortage_qty > 0)
    .sort((left, right) => right.shortage_qty - left.shortage_qty || right.priority_score - left.priority_score || right.monthly_demand - left.monthly_demand);
}

export async function getDashboardData(env: CsdDataEnv): Promise<{
  metrics: Record<string, number>;
  priority_parts: PlanningRow[];
  recent_import: { filename: string; created_at: string; data_type: string; version_code: string | null } | null;
  production_orders: ProductionOrder[];
}> {
  const [rows, recentImports, productionOrders] = await Promise.all([
    getPlanningRows(env),
    readRows<{ filename: string; created_at: string; data_type: string; version_code: string | null }>(
      env,
      "SELECT filename, created_at, data_type, version_code FROM import_versions WHERE status = ? ORDER BY id DESC LIMIT ?",
      ["active", 1],
    ),
    readRows<ProductionOrder>(
      env,
      "SELECT id, material_number, suggested_qty, confirmed_qty, expected_date, status, notes, created_at, updated_at, deleted_at, deleted_by FROM production_orders WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?",
      [8],
    ),
  ]);
  const quantity = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

  return {
    metrics: {
      part_count: rows.length,
      shortage_part_count: rows.filter((row) => row.shortage_qty > 0).length,
      shortage_qty: quantity(rows.reduce((total, row) => total + row.shortage_qty, 0)),
      in_transit_qty: quantity(rows.reduce((total, row) => total + row.in_transit, 0)),
      pending_production_qty: quantity(rows.reduce((total, row) => total + row.pending_production, 0)),
    },
    priority_parts: rows.slice(0, 8),
    recent_import: recentImports[0] ?? null,
    production_orders: productionOrders,
  };
}
