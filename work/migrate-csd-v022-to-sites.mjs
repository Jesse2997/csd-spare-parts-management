import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

import XLSX from "xlsx";

const SOURCE_WORKBOOK = "/Users/jesse/Desktop/CSD管理系統/CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx";
const REPORT_DIRECTORY = "/Users/jesse/Desktop/CSD管理系統/work/migration-reports";
const REPORT_PATH = `${REPORT_DIRECTORY}/v022-dry-run.json`;
const APPLIED_REPORT_PATH = `${REPORT_DIRECTORY}/v022-applied.json`;
const EXPECTED_SOURCE = Object.freeze({ parts: 120, stockRows: 124, rmaRecords: 5996, shipmentRows: 98 });
const REQUIRED_SHEETS = ["缺料表", "Overall battery list 2026", "CSD&客戶庫存", "總出貨"];
const PRIVATE_DEPLOYMENT_CONTRACT_VERSION = "csd-owner-only-v1";
const BASELINE_MIGRATION_CONTRACT = "csd-baseline-v022-1";
const BASELINE_MIGRATION_PATH = "/api/admin/migrations/v0.2.2";
const BASELINE_RECONCILIATION_PATH = `${BASELINE_MIGRATION_PATH}/reconciliation`;
const BASELINE_CONTRACT_PATH = `${BASELINE_MIGRATION_PATH}/contract`;
const BASELINE_MIGRATION_KEY = "csd-v022-baseline";
const BASELINE_MIGRATION_FILENAME = "CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx";
const BASELINE_MIGRATION_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BASELINE_MIGRATION_MAX_BYTES = 512 * 1024;
const SOURCE_WORKBOOK_SHA256 = "277391e3506146a71f7ff5dde803a647f5ebf8f024606f76e349938bff8099f3";
const EXPECTED_DASHBOARD = Object.freeze({
  asOfDate: "2026-07-23",
  shortage_part_count: 5,
  shortage_qty: 137.1,
  in_transit_qty: 989,
  pending_production_qty: 0,
});

const text = (value) => String(value ?? "").trim();

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(text(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const match = text(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : null;
}

function rows(workbook, sheetName) {
  const worksheet = workbook.Sheets[sheetName];
  return worksheet ? XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: null }) : [];
}

function normalizeMatcher(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function parseWorkbook(workbook) {
  const sourceParsingErrors = [];
  for (const sheetName of REQUIRED_SHEETS) {
    if (!workbook.Sheets[sheetName]) sourceParsingErrors.push(`缺少必要工作表：${sheetName}`);
  }
  if (sourceParsingErrors.length) {
    return { parts: [], stocks: [], rmas: [], shipments: [], sourceParsingErrors };
  }

  const parts = [];
  const partNumbers = new Set();
  for (const [offset, row] of rows(workbook, "缺料表").slice(1).entries()) {
    const materialNumber = text(row[4]);
    if (!materialNumber) continue;
    if (partNumbers.has(materialNumber)) {
      sourceParsingErrors.push(`缺料表第 ${offset + 2} 列：料號 ${materialNumber} 重複，已略過重複列`);
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
      inbound_qty: Math.max(0, number(row[20])),
      imported_planned_qty: Math.max(0, number(row[19])),
      notes: text(row[27]) || null,
    });
  }

  const stockRows = rows(workbook, "CSD&客戶庫存");
  const stockHeaders = stockRows[0] ?? [];
  const warehouseColumns = stockHeaders.flatMap((label, column) => {
    const normalized = text(label);
    return normalized.toUpperCase().includes("STOCK")
      ? [{ column, warehouse: normalized.replace(/\s*STOCK\s*$/i, "") }]
      : [];
  });
  const stocks = [];
  for (const row of stockRows.slice(1)) {
    for (const { column, warehouse } of warehouseColumns) {
      const materialNumber = text(row[column]);
      if (!materialNumber) continue;
      stocks.push({ material_number: materialNumber, warehouse, bin_location: null, quantity: number(row[column + 1]) });
    }
  }

  const partMatchers = parts.map((part) => ({
    materialNumber: part.material_number,
    keys: [part.pn_key, part.pn_key2, part.model].map(normalizeMatcher).filter((key) => key.length >= 4),
  }));
  const rmas = [];
  for (const row of rows(workbook, "Overall battery list 2026").slice(1)) {
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

  const shipments = [];
  for (const row of rows(workbook, "總出貨").slice(1)) {
    const materialNumber = text(row[0]);
    if (!materialNumber) continue;
    for (const [offset, value] of row.slice(2, 18).entries()) {
      const quantity = number(value);
      if (quantity) shipments.push({ material_number: materialNumber, shipment_year: 2020 + offset, quantity });
    }
  }

  return { parts, stocks, rmas, shipments, sourceParsingErrors };
}

function monthFloor(date, months) {
  const [yearText, monthText] = date.split("-");
  let year = Number(yearText);
  let month = Number(monthText) - months;
  while (month <= 0) {
    year -= 1;
    month += 12;
  }
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const round1 = (value) => Math.round((value + Number.EPSILON) * 10) / 10;

function projectDashboard({ parts, stocks, rmas }) {
  const asOfDate = rmas.reduce((latest, record) => record.service_date > latest ? record.service_date : latest, "");
  const thresholds = Object.fromEntries([1, 3, 6, 12].map((months) => [months, monthFloor(asOfDate, months)]));
  const rmaDatesByPart = new Map();
  for (const record of rmas) {
    if (!record.material_number) continue;
    const dates = rmaDatesByPart.get(record.material_number) ?? [];
    dates.push(record.service_date);
    rmaDatesByPart.set(record.material_number, dates);
  }
  const csdStockByPart = new Map();
  for (const stock of stocks) {
    if (!stock.warehouse.toUpperCase().startsWith("CSD")) continue;
    csdStockByPart.set(stock.material_number, (csdStockByPart.get(stock.material_number) ?? 0) + stock.quantity);
  }

  const projectedRows = parts.map((part) => {
    const dates = rmaDatesByPart.get(part.material_number) ?? [];
    const count = (months) => dates.filter((date) => date >= thresholds[months]).length;
    const demand = count(1) * 0.4 + count(3) / 3 * 0.3 + count(6) / 6 * 0.2 + count(12) / 12 * 0.1;
    const available = (csdStockByPart.get(part.material_number) ?? 0) + part.inbound_qty + part.imported_planned_qty;
    return { shortageQuantity: round2(Math.max(0, demand * part.safety_months - available)) };
  });

  return {
    asOfDate,
    shortagePartCount: projectedRows.filter((row) => row.shortageQuantity > 0).length,
    shortageQuantity: round1(projectedRows.reduce((total, row) => total + row.shortageQuantity, 0)),
    inTransitQuantity: round1(parts.reduce((total, part) => total + part.inbound_qty, 0)),
    pendingProductionQuantity: round1(parts.reduce((total, part) => total + part.imported_planned_qty, 0)),
  };
}

function sourceCounts(payload) {
  return {
    parts: payload.parts.length,
    stockRows: payload.stocks.length,
    rmaRecords: payload.rmas.length,
    shipmentRows: payload.shipments.length,
  };
}

function mismatches(actual) {
  return Object.entries(EXPECTED_SOURCE).flatMap(([field, expected]) => actual[field] === expected
    ? []
    : [{ field, expected, actual: actual[field] }]);
}

async function writeReport(report, reportPath = REPORT_PATH) {
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  const temporaryPath = `${reportPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporaryPath, reportPath);
}

function optionValue(arguments_, name) {
  const matchingIndexes = arguments_.flatMap((value, index) => value === name ? [index] : []);
  if (matchingIndexes.length !== 1) throw new Error(`--apply 必須提供一次 ${name}`);
  const value = arguments_[matchingIndexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`--apply 必須提供 ${name} 的值`);
  return value;
}

function privateEndpoint(value, description) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${description} 必須是 HTTPS URL`);
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (endpoint.protocol !== "https:") throw new Error(`${description} 必須使用 HTTPS`);
  if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error(`${description} 必須是沒有路徑、查詢參數或帳密的 Sites origin`);
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error(`${description} 不可使用 localhost`);
  if (isIP(hostname)) throw new Error(`${description} 不可使用 IP 位址`);
  if (hostname === "trycloudflare.com" || hostname.endsWith(".trycloudflare.com")) {
    throw new Error(`${description} 不可使用 Cloudflare trycloudflare tunnel`);
  }
  return endpoint;
}

function privateApiPath(value, description) {
  if (typeof value !== "string" || !/^\/(?!\/)/.test(value)) throw new Error(`${description} 必須是同 origin 的絕對 API 路徑`);
  const url = new URL(value, "https://private.invalid");
  if (url.origin !== "https://private.invalid" || url.search || url.hash) throw new Error(`${description} 不可包含 origin、查詢參數或 hash`);
  return url.pathname;
}

function parseArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--dry-run") return { mode: "dry-run" };
  if (!arguments_.includes("--apply")) throw new Error("用法：node work/migrate-csd-v022-to-sites.mjs --dry-run");
  const allowed = new Set(["--apply", "--endpoint", "--private-deployment-contract"]);
  for (const [index, value] of arguments_.entries()) {
    if (allowed.has(value)) continue;
    if (arguments_[index - 1] === "--endpoint" || arguments_[index - 1] === "--private-deployment-contract") continue;
    throw new Error("用法：node work/migrate-csd-v022-to-sites.mjs --apply --endpoint https://owner.example --private-deployment-contract /absolute/path/private-deployment.json");
  }
  return {
    mode: "apply",
    endpoint: privateEndpoint(optionValue(arguments_, "--endpoint"), "--endpoint"),
    contractPath: optionValue(arguments_, "--private-deployment-contract"),
  };
}

async function readPrivateDeploymentContract(contractPath, endpoint, readFileImpl) {
  let contract;
  try {
    contract = JSON.parse(await readFileImpl(contractPath, "utf8"));
  } catch {
    throw new Error("無法讀取 private deployment contract；--apply 未進行任何網路或資料寫入");
  }
  if (contract?.version !== PRIVATE_DEPLOYMENT_CONTRACT_VERSION
    || contract?.privateAccess?.provider !== "cloudflare-access"
    || contract?.privateAccess?.ownerOnly !== true) {
    throw new Error("private deployment contract 必須記錄 Cloudflare Access owner-only 驗證；--apply 未進行任何網路或資料寫入");
  }
  const contractEndpoint = privateEndpoint(contract.endpoint, "private deployment contract endpoint");
  if (contractEndpoint.origin !== endpoint.origin) {
    throw new Error("--endpoint does not match the owner-only private deployment contract endpoint；--apply 未進行任何網路或資料寫入");
  }
  const healthCheck = contract.unauthenticatedHealthCheck;
  if (healthCheck?.path !== "/api/health" || !Array.isArray(healthCheck.deniedStatuses)
    || !healthCheck.deniedStatuses.every((status) => status === 401 || status === 403)
    || healthCheck.deniedStatuses.length === 0) {
    throw new Error("private deployment contract 必須要求 /api/health 未驗證請求回傳 401 或 403；--apply 未進行任何網路或資料寫入");
  }
  const migrationContractPath = privateApiPath(contract?.migrationApi?.contractPath, "private deployment contract migrationApi.contractPath");
  if (migrationContractPath !== BASELINE_CONTRACT_PATH) {
    throw new Error("private deployment contract 未指定目前可用的 v0.2.2 migration API；--apply 未進行任何網路或資料寫入");
  }
  return { healthCheck, contractPath: migrationContractPath };
}

async function verifyPrivateDeployment(endpoint, contract, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("缺少可用的 fetch 實作；--apply 未進行任何資料寫入");
  const healthUrl = new URL(contract.healthCheck.path, endpoint).toString();
  const response = await fetchImpl(healthUrl, { method: "GET", redirect: "manual" });
  if (!contract.healthCheck.deniedStatuses.includes(response.status)) {
    throw new Error("private deployment contract 的未驗證存取檢查失敗；--apply 未進行任何資料寫入");
  }
}

function sameCounts(actual, expected = EXPECTED_SOURCE) {
  return Object.keys(expected).every((key) => actual?.[key] === expected[key]);
}

function sameDashboard(actual) {
  return Object.entries(EXPECTED_DASHBOARD).every(([key, expected]) => actual?.[key] === expected);
}

function validVersionCode(value) {
  return typeof value === "string" && /^V\d{6}$/.test(value);
}

async function verifiedSourceWorkbook(readFileImpl) {
  const workbookBytes = await readFileImpl(SOURCE_WORKBOOK);
  const sourceWorkbookSha256 = createHash("sha256").update(workbookBytes).digest("hex");
  if (sourceWorkbookSha256 !== SOURCE_WORKBOOK_SHA256) {
    throw new Error("指定 v0.2.2 原始檔雜湊不符；--apply 未進行任何資料寫入");
  }
  if (workbookBytes.byteLength > BASELINE_MIGRATION_MAX_BYTES) {
    throw new Error("指定 v0.2.2 原始檔超過 Worker baseline migration 上限；--apply 未進行任何資料寫入");
  }
  const workbook = XLSX.read(workbookBytes, { type: "buffer", cellDates: true });
  const payload = parseWorkbook(workbook);
  const source = sourceCounts(payload);
  const countMismatches = mismatches(source);
  if (payload.sourceParsingErrors.length || countMismatches.length || !sameCounts(source)) {
    throw new Error("指定 v0.2.2 原始檔未通過來源資料核對；--apply 未進行任何資料寫入");
  }
  return { workbookBytes, payload, source, sourceWorkbookSha256 };
}

function validateRemoteMigrationContract(value) {
  if (!value || value.contractVersion !== BASELINE_MIGRATION_CONTRACT
    || value.applyPath !== BASELINE_MIGRATION_PATH
    || value.reconciliationPath !== BASELINE_RECONCILIATION_PATH
    || value.filename !== BASELINE_MIGRATION_FILENAME
    || value.contentType !== BASELINE_MIGRATION_CONTENT_TYPE
    || value.maxBytes !== BASELINE_MIGRATION_MAX_BYTES
    || value.sourceSha256 !== SOURCE_WORKBOOK_SHA256
    || !sameCounts(value.expectedSource)) {
    throw new Error("已部署的 migration API contract 不符合 v0.2.2 baseline 契約；--apply 未進行任何資料寫入");
  }
  return value;
}

async function fetchJson(fetchImpl, url, init, failure) {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(failure);
  try {
    return await response.json();
  } catch {
    throw new Error(failure);
  }
}

async function postBaseline(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  if (response.status === 409) return null;
  if (!response.ok) throw new Error("首版 migration API 拒絕遷移；請先檢查私有 Sites 部署與資料庫 migration");
  try {
    return await response.json();
  } catch {
    throw new Error("首版 migration API 拒絕遷移；請先檢查私有 Sites 部署與資料庫 migration");
  }
}

async function runDryRun() {

  const workbookBytes = await readFile(SOURCE_WORKBOOK);
  const workbook = XLSX.read(workbookBytes, { type: "buffer", cellDates: true });
  const payload = parseWorkbook(workbook);
  const source = sourceCounts(payload);
  const countMismatches = mismatches(source);
  const unmatchedRmaRecords = payload.rmas.filter((record) => !record.material_number).length;
  const report = {
    migrationVersion: "v022-dry-run",
    mode: "dry-run",
    targetStatus: "projected-only",
    applyExecuted: false,
    generatedAt: new Date().toISOString(),
    sourceWorkbook: SOURCE_WORKBOOK,
    sourceWorkbookSha256: createHash("sha256").update(workbookBytes).digest("hex"),
    source,
    target: { ...source },
    sourceParsingErrors: payload.sourceParsingErrors,
    countMismatches,
    dashboard: projectDashboard(payload),
    diagnostics: {
      matchedRmaRecords: payload.rmas.length - unmatchedRmaRecords,
      unmatchedRmaRecords,
    },
  };

  await writeReport(report);
  console.log(JSON.stringify({ reportPath: REPORT_PATH, source, dashboard: report.dashboard, applyExecuted: false }, null, 2));
  if (payload.sourceParsingErrors.length || countMismatches.length) process.exitCode = 1;
  return report;
}

async function runApply({ endpoint, contractPath, fetchImpl, readFileImpl, ownerAuthorization, writeReportImpl }) {
  const contract = await readPrivateDeploymentContract(contractPath, endpoint, readFileImpl);
  await verifyPrivateDeployment(endpoint, contract, fetchImpl);
  const sitesBypassToken = String(ownerAuthorization ?? process.env.CSD_OWNER_MIGRATION_AUTHORIZATION ?? "").trim();
  if (!sitesBypassToken) throw new Error("缺少 owner-only Sites bypass token；no writes were sent. 不得把 Cloudflare Access 的未驗證拒絕當成已驗證身分。");
  const ownerHeaders = { "oai-sites-authorization": `Bearer ${sitesBypassToken}` };
  const remoteContract = validateRemoteMigrationContract(await fetchJson(
    fetchImpl,
    new URL(contract.contractPath, endpoint).toString(),
    { method: "GET", redirect: "manual", headers: ownerHeaders },
    "無法讀取已部署的 owner-only migration API contract；--apply 未進行任何資料寫入",
  ));
  const { workbookBytes, payload, source, sourceWorkbookSha256 } = await verifiedSourceWorkbook(readFileImpl);
  const applyUrl = new URL(remoteContract.applyPath, endpoint).toString();
  const applied = await postBaseline(fetchImpl, applyUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...ownerHeaders,
      "content-type": BASELINE_MIGRATION_CONTENT_TYPE,
      "x-csd-migration-contract": BASELINE_MIGRATION_CONTRACT,
      "x-csd-migration-filename": BASELINE_MIGRATION_FILENAME,
      "x-csd-migration-sha256": sourceWorkbookSha256,
    },
    body: workbookBytes,
  });
  if (applied !== null && (applied?.migration_version !== "v0.2.2-baseline" || !Number.isInteger(applied?.version_id) || !sameCounts(applied?.target))) {
    throw new Error("首版 migration API 回覆未通過核對；未寫入套用報告");
  }
  const reconciliation = await fetchJson(fetchImpl, new URL(remoteContract.reconciliationPath, endpoint).toString(), {
    method: "GET",
    redirect: "manual",
    headers: ownerHeaders,
  }, "無法讀取首版遷移目標核對結果；未寫入套用報告");
  if (reconciliation?.migrationKey !== BASELINE_MIGRATION_KEY
    || reconciliation?.migrationVersion !== "v0.2.2-baseline"
    || reconciliation?.sourceSha256 !== SOURCE_WORKBOOK_SHA256
    || !Number.isInteger(reconciliation?.versionId)
    || reconciliation.versionId < 1
    || (applied !== null && reconciliation.versionId !== applied.version_id)
    || !validVersionCode(reconciliation?.versionCode)
    || !sameCounts(reconciliation?.target)
    || !sameDashboard(reconciliation?.dashboard)) {
    throw new Error("首版遷移目標核對不符；未寫入套用報告");
  }
  const dashboard = reconciliation.dashboard;
  const report = {
    migrationVersion: reconciliation.migrationVersion,
    mode: "apply",
    targetStatus: "reconciled",
    applyExecuted: true,
    generatedAt: new Date().toISOString(),
    sourceWorkbook: SOURCE_WORKBOOK,
    sourceWorkbookSha256,
    source,
    target: reconciliation.target,
    sourceParsingErrors: payload.sourceParsingErrors,
    countMismatches: [],
    dashboard: {
      asOfDate: dashboard.asOfDate,
      shortagePartCount: dashboard.shortage_part_count,
      shortageQuantity: dashboard.shortage_qty,
      inTransitQuantity: dashboard.in_transit_qty,
      pendingProductionQuantity: dashboard.pending_production_qty,
    },
    migrationVersionCode: reconciliation.versionCode,
    migrationVersionId: reconciliation.versionId,
  };
  await writeReportImpl(report, APPLIED_REPORT_PATH);
  console.log(JSON.stringify({ reportPath: APPLIED_REPORT_PATH, source, target: report.target, applyExecuted: true }, null, 2));
  return report;
}

export async function runMigration({ args = process.argv.slice(2), fetchImpl = globalThis.fetch, readFileImpl = readFile, ownerAuthorization, writeReportImpl = writeReport } = {}) {
  const command = parseArguments(args);
  if (command.mode === "dry-run") return runDryRun();
  return runApply({ ...command, fetchImpl, readFileImpl, ownerAuthorization, writeReportImpl });
}

async function main() {
  await runMigration();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
