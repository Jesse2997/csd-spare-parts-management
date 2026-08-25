import * as XLSX from "xlsx";

import type { BaselineMigrationPayload, ImportKind, ImportMode, PartRecord, RmaRecord, ShipmentRecord, StockRecord } from "./csd-types.ts";

export type ParsedImport = {
  dataType: ImportKind;
  mode: ImportMode;
  summary: Record<string, number>;
  errors: string[];
  warnings: string[];
  scope: string[];
  items: PartRecord[] | RmaRecord[] | StockRecord[];
  canCommit: boolean;
};

type UpdateRecord = PartRecord | RmaRecord | StockRecord;

const SHEET_FOR: Record<ImportKind, string> = {
  rma: "RMA",
  inventory: "庫存快照",
  master: "料號主檔",
};

const REQUIRED_HEADERS: Record<ImportKind, string[]> = {
  rma: ["RMA日期", "料號"],
  inventory: ["倉庫", "料號", "數量"],
  master: ["料號"],
};

export const MAX_IMPORT_ROWS = 10_000;

export const BASELINE_MIGRATION_CONTRACT = "csd-baseline-v022-1";
export const BASELINE_MIGRATION_FILENAME = "CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx";
export const BASELINE_MIGRATION_SHA256 = "277391e3506146a71f7ff5dde803a647f5ebf8f024606f76e349938bff8099f3";
export const BASELINE_MIGRATION_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_BASELINE_MIGRATION_BYTES = 512 * 1024;
export const BASELINE_SOURCE_COUNTS = Object.freeze({ parts: 120, stockRows: 124, rmaRecords: 5996, shipmentRows: 98 });

type BaselineCountKey = keyof typeof BASELINE_SOURCE_COUNTS;

export type ParsedBaselineMigration = {
  payload: BaselineMigrationPayload;
  summary: typeof BASELINE_SOURCE_COUNTS & { records: number };
  errors: string[];
  warnings: string[];
  canCommit: boolean;
};

const text = (value: unknown): string => String(value ?? "").trim();

export const normalizeWarehouseIdentifier = (value: unknown): string => text(value).toUpperCase();

const normalizeBinLocationIdentifier = (value: unknown): string => text(value).toUpperCase();

const baselineSheetRows = (workbook: XLSX.WorkBook, sheetName: string): unknown[][] => {
  const worksheet = workbook.Sheets[sheetName];
  return worksheet ? XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: null }) : [];
};

const normalizeMatcher = (value: unknown): string => text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

function legacyNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(text(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueAt(row: unknown[], headers: Map<string, number>, name: string): unknown {
  const index = headers.get(name);
  return index === undefined ? undefined : row[index];
}

function strictNumber(value: unknown): number | null {
  if (value === null || value === undefined || text(value) === "" || text(value) === "-") return null;
  const result = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(result) ? result : null;
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (match) {
      const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
      const date = new Date(`${normalized}T00:00:00Z`);
      if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === normalized) return normalized;
    }
  }
  return null;
}

export function parseBaselineMigrationWorkbook(bytes: ArrayBuffer): ParsedBaselineMigration {
  const errors: string[] = [];
  const warnings: string[] = [];
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  } catch {
    return {
      payload: { parts: [], stocks: [], rmas: [], shipments: [] },
      summary: { parts: 0, stockRows: 0, rmaRecords: 0, shipmentRows: 0, records: 0 },
      errors: ["無法讀取首版整合 Excel 檔案"],
      warnings,
      canCommit: false,
    };
  }

  const requiredSheets = ["缺料表", "Overall battery list 2026", "CSD&客戶庫存", "總出貨"];
  for (const sheetName of requiredSheets) {
    if (!workbook.Sheets[sheetName]) errors.push(`缺少必要工作表：${sheetName}`);
  }
  if (errors.length) {
    return {
      payload: { parts: [], stocks: [], rmas: [], shipments: [] },
      summary: { parts: 0, stockRows: 0, rmaRecords: 0, shipmentRows: 0, records: 0 },
      errors,
      warnings,
      canCommit: false,
    };
  }

  const parts: PartRecord[] = [];
  const partNumbers = new Set<string>();
  for (const [offset, row] of baselineSheetRows(workbook, "缺料表").slice(1).entries()) {
    const materialNumber = text(row[4]);
    if (!materialNumber) continue;
    if (partNumbers.has(materialNumber)) {
      errors.push(`缺料表第 ${offset + 2} 列：料號 ${materialNumber} 重複`);
      continue;
    }
    partNumbers.add(materialNumber);
    parts.push({
      material_number: materialNumber,
      site: text(row[0]) || null,
      model: text(row[1]) || null,
      pn_key: text(row[2]) || null,
      pn_key2: text(row[3]) || null,
      target_months: 6,
      safety_months: 3,
      demand_override: null,
      safety_override: null,
      active: true,
      inbound_qty: Math.max(0, legacyNumber(row[20])),
      imported_planned_qty: Math.max(0, legacyNumber(row[19])),
      notes: text(row[27]) || null,
      updated_at: "",
    });
  }

  const stockRows = baselineSheetRows(workbook, "CSD&客戶庫存");
  const warehouseColumns = (stockRows[0] ?? []).flatMap((label, column) => {
    const warehouse = text(label);
    return warehouse.toUpperCase().includes("STOCK")
      ? [{ column, warehouse: normalizeWarehouseIdentifier(warehouse.replace(/\s*STOCK\s*$/i, "")) }]
      : [];
  });
  const stocks: StockRecord[] = [];
  for (const row of stockRows.slice(1)) {
    for (const { column, warehouse } of warehouseColumns) {
      const materialNumber = text(row[column]);
      if (!materialNumber) continue;
      stocks.push({ material_number: materialNumber, warehouse, bin_location: null, quantity: legacyNumber(row[column + 1]) });
    }
  }

  const partMatchers = parts.map((part) => ({
    materialNumber: part.material_number,
    keys: [part.pn_key, part.pn_key2, part.model].map(normalizeMatcher).filter((key) => key.length >= 4),
  }));
  const rmas: RmaRecord[] = [];
  for (const row of baselineSheetRows(workbook, "Overall battery list 2026").slice(1)) {
    const serviceDate = isoDate(row[1]);
    if (!serviceDate) continue;
    const modelCustomer = text(row[9]);
    const serialNumber = text(row[10]);
    const searchText = normalizeMatcher(`${modelCustomer} ${serialNumber}`);
    const materialNumber = partMatchers.find(({ keys }) => keys.some((key) => searchText.includes(key)))?.materialNumber ?? null;
    rmas.push({
      service_date: serviceDate,
      customer: text(row[5]) || null,
      region: text(row[6]) || null,
      product_type: text(row[4]) || null,
      model_customer: modelCustomer || null,
      model: text(row[12]) || null,
      serial_number: serialNumber || null,
      failure_classification: text(row[13]) || null,
      material_number: materialNumber,
    });
  }

  const shipments: ShipmentRecord[] = [];
  for (const row of baselineSheetRows(workbook, "總出貨").slice(1)) {
    const materialNumber = text(row[0]);
    if (!materialNumber) continue;
    for (const [offset, value] of row.slice(2, 18).entries()) {
      const quantity = legacyNumber(value);
      if (quantity) shipments.push({ material_number: materialNumber, shipment_year: 2020 + offset, quantity });
    }
  }

  const counts = { parts: parts.length, stockRows: stocks.length, rmaRecords: rmas.length, shipmentRows: shipments.length };
  for (const key of Object.keys(BASELINE_SOURCE_COUNTS) as BaselineCountKey[]) {
    if (counts[key] !== BASELINE_SOURCE_COUNTS[key]) errors.push(`首版資料 ${key} 筆數不符：預期 ${BASELINE_SOURCE_COUNTS[key]}，實際 ${counts[key]}`);
  }
  return {
    payload: { parts, stocks, rmas, shipments },
    summary: { ...counts, records: parts.length + stocks.length + rmas.length + shipments.length },
    errors,
    warnings,
    canCommit: errors.length === 0,
  };
}

export function rmaKey(record: Pick<RmaRecord, "material_number" | "service_date" | "serial_number" | "customer" | "failure_classification">): string {
  return [record.material_number, record.service_date, record.serial_number, record.customer, record.failure_classification]
    .map((value) => text(value).toUpperCase())
    .join("|");
}

export function safeFilename(filename: string): string {
  const name = filename.split(/[\\/]/).at(-1) ?? "";
  return name.replace(/[^A-Za-z0-9._-]/g, "_") || "upload.xlsx";
}

const TEMPLATE_HEADERS: Record<ImportKind, string[]> = {
  rma: ["RMA日期", "料號", "客戶", "地區", "產品類別", "客戶機種", "機種", "序號", "故障分類"],
  inventory: ["倉庫", "料號", "儲位", "數量"],
  master: ["料號", "Site", "機種", "PN Key", "PN Key 2", "在途量", "既有待投產量", "備註"],
};

function writeWorkbook(sheetName: string, rows: unknown[][]): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
}

export function createTemplateWorkbook(dataType: ImportKind): ArrayBuffer {
  return writeWorkbook(SHEET_FOR[dataType], [TEMPLATE_HEADERS[dataType]]);
}

export function createDataWorkbook(dataType: ImportKind, records: unknown[]): ArrayBuffer {
  const headers = TEMPLATE_HEADERS[dataType];
  const columns: Record<ImportKind, string[]> = {
    rma: ["service_date", "material_number", "customer", "region", "product_type", "model_customer", "model", "serial_number", "failure_classification"],
    inventory: ["warehouse", "material_number", "bin_location", "quantity"],
    master: ["material_number", "site", "model", "pn_key", "pn_key2", "inbound_qty", "imported_planned_qty", "notes"],
  };
  const rows = records.map((record) => columns[dataType].map((column) => {
    const value = (record as Record<string, unknown>)[column];
    return value ?? "";
  }));
  return writeWorkbook(SHEET_FOR[dataType], [headers, ...rows]);
}

export async function parseUpdateWorkbook(
  bytes: ArrayBuffer,
  dataType: ImportKind,
  mode: ImportMode,
  knownParts: Set<string>,
): Promise<ParsedImport> {
  const expectedSheet = SHEET_FOR[dataType];
  if (!expectedSheet) throw new Error("無效的資料類型");

  const errors: string[] = [];
  const warnings: string[] = [];
  let rows: unknown[][] = [];
  try {
    const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
    const worksheet = workbook.Sheets[expectedSheet];
    if (!worksheet) {
      errors.push(`缺少必要工作表：${expectedSheet}`);
    } else {
      const declaredRange = worksheet["!fullref"] ?? worksheet["!ref"];
      const range = declaredRange ? XLSX.utils.decode_range(declaredRange) : null;
      if (range && range.e.r - range.s.r > MAX_IMPORT_ROWS) {
        errors.push(`${expectedSheet}：資料列不可超過 ${MAX_IMPORT_ROWS.toLocaleString("en-US")} 筆`);
      } else {
        rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: null });
      }
    }
  } catch {
    errors.push("無法讀取 Excel 檔案");
  }

  const firstRow = rows[0] ?? [];
  if (!errors.length && !firstRow.length) errors.push(`${expectedSheet}：工作表沒有資料`);
  const headers = new Map<string, number>();
  const duplicateHeaders = new Set<string>();
  for (const [index, cell] of firstRow.entries()) {
    const name = text(cell);
    if (!name) continue;
    if (headers.has(name)) duplicateHeaders.add(name);
    else headers.set(name, index);
  }
  for (const name of [...duplicateHeaders].sort()) errors.push(`${expectedSheet}：欄位「${name}」重複`);
  for (const name of REQUIRED_HEADERS[dataType]) {
    if (!headers.has(name)) errors.push(`${expectedSheet}：缺少必填欄位「${name}」`);
  }
  if (errors.length) return result(dataType, mode, [], errors, warnings, []);

  const nonEmptyRows = rows.slice(1).filter((row) => row.some((cell) => text(cell) !== "")).length;
  if (nonEmptyRows > MAX_IMPORT_ROWS) {
    errors.push(`${expectedSheet}：資料列不可超過 ${MAX_IMPORT_ROWS.toLocaleString("en-US")} 筆`);
    return result(dataType, mode, [], errors, warnings, []);
  }

  const items: UpdateRecord[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.some((cell) => text(cell) !== "")) continue;
    const rowNumber = index + 1;
    const material = text(valueAt(row, headers, "料號"));
    if (!material) {
      errors.push(`${expectedSheet} 第 ${rowNumber} 列：料號不可空白`);
      continue;
    }
    if (dataType !== "master" && !knownParts.has(material)) {
      errors.push(`${expectedSheet} 第 ${rowNumber} 列：未知料號「${material}」`);
      continue;
    }

    if (dataType === "rma") {
      const serviceDate = isoDate(valueAt(row, headers, "RMA日期"));
      if (!serviceDate) {
        errors.push(`RMA 第 ${rowNumber} 列：RMA日期格式無效`);
        continue;
      }
      const item: RmaRecord = {
        service_date: serviceDate,
        material_number: material,
        customer: text(valueAt(row, headers, "客戶")) || null,
        region: text(valueAt(row, headers, "地區")) || null,
        product_type: text(valueAt(row, headers, "產品類別")) || null,
        model_customer: text(valueAt(row, headers, "客戶機種")) || null,
        model: text(valueAt(row, headers, "機種")) || null,
        serial_number: text(valueAt(row, headers, "序號")) || null,
        failure_classification: text(valueAt(row, headers, "故障分類")) || null,
      };
      const key = rmaKey(item);
      if (seen.has(key)) {
        warnings.push(`RMA 第 ${rowNumber} 列：與本檔其他資料重複，已略過`);
        continue;
      }
      seen.add(key);
      if (!item.serial_number) warnings.push(`RMA 第 ${rowNumber} 列：序號空白，重複判定準確度較低`);
      items.push(item);
      continue;
    }

    if (dataType === "inventory") {
      const warehouse = normalizeWarehouseIdentifier(valueAt(row, headers, "倉庫"));
      const binLocation = text(valueAt(row, headers, "儲位")) || null;
      const quantity = strictNumber(valueAt(row, headers, "數量"));
      if (!warehouse) {
        errors.push(`庫存快照 第 ${rowNumber} 列：倉庫不可空白`);
        continue;
      }
      if (quantity === null) {
        errors.push(`庫存快照 第 ${rowNumber} 列：數量必須是數字`);
        continue;
      }
      if (quantity < 0) {
        errors.push(`庫存快照 第 ${rowNumber} 列：不可輸入負庫存`);
        continue;
      }
      if (quantity === 0) warnings.push(`庫存快照 第 ${rowNumber} 列：數量為 0`);
      const key = [warehouse, material, normalizeBinLocationIdentifier(binLocation)].join("|");
      if (seen.has(key)) {
        errors.push(`庫存快照 第 ${rowNumber} 列：倉庫「${warehouse}」、料號「${material}」、儲位「${binLocation ?? ""}」重複`);
        continue;
      }
      seen.add(key);
      items.push({
        material_number: material,
        warehouse,
        bin_location: binLocation ? normalizeBinLocationIdentifier(binLocation) : null,
        quantity,
      });
      continue;
    }

    const inbound = strictNumber(valueAt(row, headers, "在途量"));
    const planned = strictNumber(valueAt(row, headers, "既有待投產量"));
    if (inbound !== null && inbound < 0) {
      errors.push(`料號主檔 第 ${rowNumber} 列：在途量不可為負數`);
      continue;
    }
    if (planned !== null && planned < 0) {
      errors.push(`料號主檔 第 ${rowNumber} 列：既有待投產量不可為負數`);
      continue;
    }
    if (seen.has(material)) {
      errors.push(`料號主檔 第 ${rowNumber} 列：料號「${material}」重複`);
      continue;
    }
    seen.add(material);
    items.push({
      material_number: material,
      site: text(valueAt(row, headers, "Site")) || null,
      model: text(valueAt(row, headers, "機種")) || null,
      pn_key: text(valueAt(row, headers, "PN Key")) || null,
      pn_key2: text(valueAt(row, headers, "PN Key 2")) || null,
      target_months: 6,
      safety_months: 3,
      demand_override: null,
      safety_override: null,
      active: true,
      inbound_qty: inbound ?? 0,
      imported_planned_qty: planned ?? 0,
      notes: text(valueAt(row, headers, "備註")) || null,
      updated_at: "",
    });
  }

  const scope = dataType === "inventory"
    ? [...new Set(items.map((item) => "warehouse" in item ? item.warehouse : "").filter(Boolean))].sort()
    : [];
  if (dataType === "inventory" && mode === "partial" && items.length) {
    warnings.push("指定倉庫更新只會取代本檔案出現的倉庫，其餘倉庫資料維持不變");
  }
  return result(dataType, mode, items, errors, warnings, scope);
}

function result(dataType: ImportKind, mode: ImportMode, items: UpdateRecord[], errors: string[], warnings: string[], scope: string[]): ParsedImport {
  return {
    dataType,
    mode,
    items: items as ParsedImport["items"],
    summary: {
      records: items.length,
      errors: errors.length,
      warnings: warnings.length,
      warehouses: scope.length,
    },
    errors,
    warnings,
    scope,
    canCommit: errors.length === 0,
  };
}
