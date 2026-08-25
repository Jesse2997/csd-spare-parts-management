import { getCurrentRmaRecords, getDashboardData, getKnownPartNumbers, getPlanningRows, type CsdDataEnv } from "./csd-data.ts";
import type { CsdAccess } from "./csd-auth.ts";
import {
  BASELINE_MIGRATION_CONTRACT,
  BASELINE_MIGRATION_CONTENT_TYPE,
  BASELINE_MIGRATION_FILENAME,
  BASELINE_MIGRATION_SHA256,
  BASELINE_SOURCE_COUNTS,
  MAX_BASELINE_MIGRATION_BYTES,
  createDataWorkbook,
  createTemplateWorkbook,
  parseBaselineMigrationWorkbook,
  parseUpdateWorkbook,
  normalizeWarehouseIdentifier,
  rmaKey,
  safeFilename,
  type ParsedImport,
} from "./csd-import.ts";
import type { BaselineMigrationPayload, DataVersion, ImportKind, ImportMode, PartRecord, ProductionOrder, RmaRecord, StockRecord, VersionDataType } from "./csd-types.ts";

export type CsdEnv = CsdDataEnv & { IMPORTS?: R2Bucket };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

const MAX_MESSAGES = 100;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_VERSION_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_CURRENT_EXPORT_ROWS = 10_000;
const CURRENT_EXPORT_ESTIMATED_BYTES_PER_ROW = 512;
const MAX_CURRENT_EXPORT_ESTIMATED_BYTES = 4 * 1024 * 1024;
const VERSION_PAYLOAD_LIMIT_ERROR = "版本 snapshot 不可超過 2 MiB";
const ACTIVATION_RECONCILIATION_ERROR = "D1 啟用結果無法確認，已保留資料版本與原始檔待核對";
const BASELINE_MIGRATION_PATH = "/api/admin/migrations/v0.2.2";
const BASELINE_RECONCILIATION_PATH = `${BASELINE_MIGRATION_PATH}/reconciliation`;
const BASELINE_CONTRACT_PATH = `${BASELINE_MIGRATION_PATH}/contract`;
const BASELINE_MIGRATION_KEY = "csd-v022-baseline";

function isImportKind(value: string): value is ImportKind {
  return value === "rma" || value === "inventory" || value === "master";
}

function isVersionDataType(value: string): value is VersionDataType {
  return isImportKind(value) || value === "baseline";
}

function isImportMode(dataType: ImportKind, value: string): value is ImportMode {
  return (dataType === "rma" && (value === "full" || value === "incremental"))
    || (dataType === "inventory" && (value === "full" || value === "partial"))
    || (dataType === "master" && value === "full");
}

function publicPreview(filename: string, parsed: ParsedImport) {
  return {
    filename,
    dataType: parsed.dataType,
    mode: parsed.mode,
    summary: parsed.summary,
    errors: parsed.errors.slice(0, MAX_MESSAGES),
    warnings: parsed.warnings.slice(0, MAX_MESSAGES),
    scope: parsed.scope,
    canCommit: parsed.canCommit,
  };
}

type ImportItems = PartRecord[] | RmaRecord[] | StockRecord[];

type PreparedImport = {
  parsed: ParsedImport;
  payload: ImportItems;
  currentItems: ImportItems;
  warnings: string[];
};

async function prepareImport(env: CsdEnv, parsed: ParsedImport): Promise<PreparedImport> {
  if (parsed.dataType !== "rma" || parsed.mode !== "incremental") {
    return { parsed, payload: parsed.items, currentItems: parsed.items, warnings: parsed.warnings };
  }

  const existing = await getCurrentRmaRecords(env);
  const existingKeys = new Set(existing.map(rmaKey));
  const warnings = [...parsed.warnings];
  const append = (parsed.items as RmaRecord[]).filter((record) => {
    if (!existingKeys.has(rmaKey(record))) return true;
    warnings.push(`RMA：${record.material_number} / ${record.service_date} 已存在，增量匯入時略過`);
    return false;
  });
  return {
    parsed: {
      ...parsed,
      items: append,
      warnings,
      summary: { ...parsed.summary, records: append.length, warnings: warnings.length },
    },
    currentItems: append,
    payload: [...existing, ...append],
    warnings,
  };
}

async function importForm(request: Request): Promise<{ dataType: ImportKind; mode: ImportMode; file: File; operator: string } | Response> {
  const form = await request.formData();
  const dataType = String(form.get("data_type") ?? "");
  const mode = String(form.get("mode") ?? "full");
  const file = form.get("file");
  if (!isImportKind(dataType) || !isImportMode(dataType, mode) || !(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx")) {
    return json({ detail: "請使用系統範本上傳 .xlsx 檔案，並選擇正確的匯入方式" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ detail: "上傳檔案不可超過 2 MiB" }, 413);
  }
  return { dataType, mode, file, operator: String(form.get("operator") ?? "本機使用者").trim() || "本機使用者" };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "");
}

function versionCode(createdAt: string): string {
  return `V${createdAt.slice(2, 4)}${createdAt.slice(5, 7)}${createdAt.slice(8, 10)}`;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function statement(env: CsdEnv, sql: string, values: unknown[]) {
  return env.DB.prepare(sql).bind(...values);
}

async function recordFailedImport(env: CsdEnv, versionId: number, objectKey: string | null, detail: string): Promise<void> {
  try {
    await statement(
      env,
      "UPDATE import_versions SET status = 'failed', stored_object_key = ?, errors_json = ? WHERE id = ?",
      [objectKey, JSON.stringify([detail]), versionId],
    ).run();
  } catch {
    // The pending row remains hidden from successful-version queries if this last-resort write also fails.
  }
}

async function discardPendingImport(env: CsdEnv, imports: R2Bucket, versionId: number, objectKey: string): Promise<void> {
  try {
    await imports.delete(objectKey);
  } catch {
    await recordFailedImport(env, versionId, objectKey, "原始檔清理失敗，請由管理員清理 R2 物件");
    return;
  }
  try {
    await statement(env, "DELETE FROM import_versions WHERE id = ?", [versionId]).run();
  } catch {
    await recordFailedImport(env, versionId, null, "版本清理失敗，請由管理員確認資料版本狀態");
  }
}

type ActivationResult = { versionId: number; recovered: boolean };

async function reconcileActivation(env: CsdEnv, versionId: number): Promise<"committed" | "pending" | "unknown"> {
  const result = await statement(env, `SELECT import_versions.status,
    EXISTS (
      SELECT 1 FROM baseline_migrations WHERE baseline_migrations.version_id = import_versions.id
    ) AS baseline_locked
    FROM import_versions WHERE import_versions.id = ? LIMIT ?`, [versionId, 1]).all<{ status: string; baseline_locked: number | boolean }>();
  const row = result.results?.[0];
  if (!row) return "unknown";
  if (row.status === "active" || Boolean(row.baseline_locked)) return "committed";
  return row.status === "pending" ? "pending" : "unknown";
}

async function recoverRejectedActivation(
  env: CsdEnv,
  imports: R2Bucket,
  versionId: number,
  objectKey: string,
  originalError: unknown,
): Promise<ActivationResult> {
  let activation: "committed" | "pending" | "unknown";
  try {
    activation = await reconcileActivation(env, versionId);
  } catch {
    throw new Error(ACTIVATION_RECONCILIATION_ERROR);
  }
  if (activation === "committed") return { versionId, recovered: true };
  if (activation === "pending") {
    await discardPendingImport(env, imports, versionId, objectKey);
    throw originalError;
  }
  throw new Error(ACTIVATION_RECONCILIATION_ERROR);
}

async function stageAndActivateImport(
  env: CsdEnv,
  input: { filename: string; operator: string; parsed: ParsedImport; payload: PartRecord[] | RmaRecord[] | StockRecord[]; currentItems: PartRecord[] | RmaRecord[] | StockRecord[]; warnings: string[]; bytes: ArrayBuffer },
): Promise<ActivationResult> {
  const imports = env.IMPORTS;
  if (!imports) throw new Error("R2 儲存未設定");
  const createdAt = nowIso();
  const version = await statement(
    env,
    `INSERT INTO import_versions (
      data_type, import_mode, filename, stored_object_key, created_at, created_by,
      summary_json, warnings_json, errors_json, payload_json, scope_json, version_code, status
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      input.parsed.dataType,
      input.parsed.mode,
      input.filename,
      createdAt,
      input.operator,
      JSON.stringify(input.parsed.summary),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify(input.parsed.scope),
      versionCode(createdAt),
    ],
  ).run();
  const versionId = Number(version.meta.last_row_id);
  if (!Number.isInteger(versionId) || versionId < 1) throw new Error("無法建立資料版本");

  const objectKey = `originals/${versionId}/${safeFilename(input.filename)}`;
  try {
    await imports.put(objectKey, input.bytes);
  } catch (error) {
    await discardPendingImport(env, imports, versionId, objectKey);
    throw error;
  }

  const batchLookup = "(SELECT id FROM import_batches WHERE filename = ? AND created_at = ? ORDER BY id DESC LIMIT 1)";
  const statements = [
    statement(
      env,
      "INSERT INTO import_batches (filename, created_at, summary_json, errors_json) VALUES (?, ?, ?, ?)",
      [input.filename, createdAt, JSON.stringify(input.parsed.summary), JSON.stringify([...input.warnings, ...input.parsed.errors])],
    ),
  ];

  if (input.parsed.dataType === "rma") {
    if (input.parsed.mode === "full") statements.push(statement(env, "DELETE FROM rma_records", []));
    if (input.currentItems.length) statements.push(statement(
      env,
      `INSERT INTO rma_records (batch_id, service_date, customer, region, product_type, model_customer, model, serial_number, failure_classification, material_number)
      SELECT ${batchLookup}, json_extract(value, '$.service_date'), json_extract(value, '$.customer'), json_extract(value, '$.region'),
        json_extract(value, '$.product_type'), json_extract(value, '$.model_customer'), json_extract(value, '$.model'),
        json_extract(value, '$.serial_number'), json_extract(value, '$.failure_classification'), json_extract(value, '$.material_number')
      FROM json_each(?)`,
      [input.filename, createdAt, JSON.stringify(input.currentItems)],
    ));
  } else if (input.parsed.dataType === "inventory") {
    if (input.parsed.mode === "full") statements.push(statement(env, "DELETE FROM stock_snapshots", []));
    else if (input.parsed.scope.length) {
      const placeholders = input.parsed.scope.map(() => "?").join(", ");
      statements.push(statement(env, `DELETE FROM stock_snapshots WHERE UPPER(TRIM(warehouse)) IN (${placeholders})`, input.parsed.scope));
    }
    if (input.currentItems.length) statements.push(statement(
      env,
      `INSERT INTO stock_snapshots (batch_id, material_number, warehouse, bin_location, quantity)
      SELECT ${batchLookup}, json_extract(value, '$.material_number'), json_extract(value, '$.warehouse'),
        json_extract(value, '$.bin_location'), json_extract(value, '$.quantity')
      FROM json_each(?)`,
      [input.filename, createdAt, JSON.stringify(input.currentItems)],
    ));
  } else {
    if (input.currentItems.length) statements.push(statement(
      env,
      `INSERT INTO parts (material_number, site, model, pn_key, pn_key2, target_months, safety_months, demand_override, safety_override, active, inbound_qty, imported_planned_qty, notes, updated_at)
      SELECT json_extract(value, '$.material_number'), json_extract(value, '$.site'), json_extract(value, '$.model'),
        json_extract(value, '$.pn_key'), json_extract(value, '$.pn_key2'), json_extract(value, '$.target_months'),
        json_extract(value, '$.safety_months'), json_extract(value, '$.demand_override'), json_extract(value, '$.safety_override'), 1,
        json_extract(value, '$.inbound_qty'), json_extract(value, '$.imported_planned_qty'), json_extract(value, '$.notes'), ?
      FROM json_each(?) WHERE true
      ON CONFLICT(material_number) DO UPDATE SET site = excluded.site, model = excluded.model, pn_key = excluded.pn_key,
        pn_key2 = excluded.pn_key2, inbound_qty = excluded.inbound_qty, imported_planned_qty = excluded.imported_planned_qty,
        notes = excluded.notes, active = excluded.active, updated_at = excluded.updated_at`,
      [createdAt, JSON.stringify(input.currentItems)],
    ));
    statements.push(statement(
      env,
      `UPDATE parts SET active = 0, updated_at = ?
      WHERE active <> 0 AND material_number NOT IN (
        SELECT json_extract(value, '$.material_number') FROM json_each(?)
      )`,
      [createdAt, JSON.stringify(input.currentItems)],
    ));
  }

  statements.push(statement(
    env,
    `UPDATE import_versions SET status = 'active', stored_object_key = ?, summary_json = ?, warnings_json = ?, errors_json = ?, payload_json = ?, scope_json = ?,
      batch_id = ${batchLookup} WHERE id = ?`,
    [objectKey, JSON.stringify(input.parsed.summary), JSON.stringify(input.warnings), JSON.stringify(input.parsed.errors), JSON.stringify(input.payload), JSON.stringify(input.parsed.scope), input.filename, createdAt, versionId],
  ));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    return recoverRejectedActivation(env, imports, versionId, objectKey, error);
  }
  return { versionId, recovered: false };
}

function baselineContractResponse(): Response {
  return json({
    contractVersion: BASELINE_MIGRATION_CONTRACT,
    applyPath: BASELINE_MIGRATION_PATH,
    reconciliationPath: BASELINE_RECONCILIATION_PATH,
    filename: BASELINE_MIGRATION_FILENAME,
    contentType: BASELINE_MIGRATION_CONTENT_TYPE,
    maxBytes: MAX_BASELINE_MIGRATION_BYTES,
    sourceSha256: BASELINE_MIGRATION_SHA256,
    expectedSource: BASELINE_SOURCE_COUNTS,
  });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function baselineBytes(request: Request): Promise<ArrayBuffer | Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.headers.get("x-csd-migration-contract") !== BASELINE_MIGRATION_CONTRACT) {
    return json({ detail: "首版遷移契約標頭無效" }, 400);
  }
  if (request.headers.get("x-csd-migration-filename") !== BASELINE_MIGRATION_FILENAME) {
    return json({ detail: "首版遷移只接受指定的 v0.2.2 原始檔名" }, 400);
  }
  if (contentType !== BASELINE_MIGRATION_CONTENT_TYPE) {
    return json({ detail: "首版遷移只接受 Excel 位元組內容" }, 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BASELINE_MIGRATION_BYTES) {
    return json({ detail: "首版遷移檔案超過大小上限" }, 413);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return json({ detail: "無法讀取首版遷移 Excel 檔案" }, 400);
  }
  if (bytes.byteLength > MAX_BASELINE_MIGRATION_BYTES) return json({ detail: "首版遷移檔案超過大小上限" }, 413);
  if (request.headers.get("x-csd-migration-sha256") !== BASELINE_MIGRATION_SHA256 || await sha256Hex(bytes) !== BASELINE_MIGRATION_SHA256) {
    return json({ detail: "首版遷移檔案雜湊不符，未進行任何寫入" }, 400);
  }
  return bytes;
}

async function baselineAlreadyApplied(env: CsdEnv): Promise<boolean> {
  const result = await statement(env, "SELECT migration_key FROM baseline_migrations WHERE migration_key = ? LIMIT ?", [BASELINE_MIGRATION_KEY, 1]).all<{ migration_key: string }>();
  return Boolean(result.results?.length);
}

async function stageAndActivateBaseline(env: CsdEnv, input: { payload: BaselineMigrationPayload; summary: Record<string, number>; bytes: ArrayBuffer }): Promise<ActivationResult> {
  const imports = env.IMPORTS;
  if (!imports) throw new Error("R2 儲存未設定");
  const createdAt = nowIso();
  const payloadJson = JSON.stringify(input.payload);
  if (jsonByteLength(input.payload) > MAX_VERSION_PAYLOAD_BYTES) throw new Error(VERSION_PAYLOAD_LIMIT_ERROR);
  const version = await statement(
    env,
    `INSERT INTO import_versions (
      data_type, import_mode, filename, stored_object_key, created_at, created_by,
      summary_json, warnings_json, errors_json, payload_json, scope_json, version_code, status
    ) VALUES ('baseline', 'baseline', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      BASELINE_MIGRATION_FILENAME,
      createdAt,
      "owner-only baseline migration",
      JSON.stringify(input.summary),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify({}),
      JSON.stringify(["parts", "stock", "rma", "shipments"]),
      versionCode(createdAt),
    ],
  ).run();
  const versionId = Number(version.meta.last_row_id);
  if (!Number.isInteger(versionId) || versionId < 1) throw new Error("無法建立首版遷移版本");

  const objectKey = `originals/${versionId}/${safeFilename(BASELINE_MIGRATION_FILENAME)}`;
  try {
    await imports.put(objectKey, input.bytes);
  } catch (error) {
    await discardPendingImport(env, imports, versionId, objectKey);
    throw error;
  }

  const batchLookup = "(SELECT id FROM import_batches WHERE filename = ? AND created_at = ? ORDER BY id DESC LIMIT 1)";
  const batchValues = [BASELINE_MIGRATION_FILENAME, createdAt];
  const statements = [
    statement(env, "INSERT INTO baseline_migrations (migration_key, version_id, created_at) VALUES (?, ?, ?)", [BASELINE_MIGRATION_KEY, versionId, createdAt]),
    statement(env, "INSERT INTO import_batches (filename, created_at, summary_json, errors_json) VALUES (?, ?, ?, ?)", [BASELINE_MIGRATION_FILENAME, createdAt, JSON.stringify(input.summary), JSON.stringify([])]),
    statement(env, "DELETE FROM shipments", []),
    statement(env, "DELETE FROM rma_records", []),
    statement(env, "DELETE FROM stock_snapshots", []),
    statement(env, "DELETE FROM parts", []),
    statement(env, `INSERT INTO parts (material_number, site, model, pn_key, pn_key2, target_months, safety_months, demand_override, safety_override, active, inbound_qty, imported_planned_qty, notes, updated_at)
      SELECT json_extract(value, '$.material_number'), json_extract(value, '$.site'), json_extract(value, '$.model'), json_extract(value, '$.pn_key'), json_extract(value, '$.pn_key2'), json_extract(value, '$.target_months'), json_extract(value, '$.safety_months'), json_extract(value, '$.demand_override'), json_extract(value, '$.safety_override'), 1, json_extract(value, '$.inbound_qty'), json_extract(value, '$.imported_planned_qty'), json_extract(value, '$.notes'), ? FROM json_each(?)`, [createdAt, JSON.stringify(input.payload.parts)]),
    statement(env, `INSERT INTO stock_snapshots (batch_id, material_number, warehouse, bin_location, quantity)
      SELECT ${batchLookup}, json_extract(value, '$.material_number'), json_extract(value, '$.warehouse'), json_extract(value, '$.bin_location'), json_extract(value, '$.quantity') FROM json_each(?)`, [...batchValues, JSON.stringify(input.payload.stocks)]),
    statement(env, `INSERT INTO rma_records (batch_id, service_date, customer, region, product_type, model_customer, model, serial_number, failure_classification, material_number)
      SELECT ${batchLookup}, json_extract(value, '$.service_date'), json_extract(value, '$.customer'), json_extract(value, '$.region'), json_extract(value, '$.product_type'), json_extract(value, '$.model_customer'), json_extract(value, '$.model'), json_extract(value, '$.serial_number'), json_extract(value, '$.failure_classification'), json_extract(value, '$.material_number') FROM json_each(?)`, [...batchValues, JSON.stringify(input.payload.rmas)]),
    statement(env, `INSERT INTO shipments (batch_id, material_number, shipment_year, quantity)
      SELECT ${batchLookup}, json_extract(value, '$.material_number'), json_extract(value, '$.shipment_year'), json_extract(value, '$.quantity') FROM json_each(?)`, [...batchValues, JSON.stringify(input.payload.shipments)]),
    statement(env, `UPDATE import_versions SET status = 'active', stored_object_key = ?, summary_json = ?, warnings_json = ?, errors_json = ?, payload_json = ?, scope_json = ?, batch_id = ${batchLookup} WHERE id = ?`, [objectKey, JSON.stringify(input.summary), JSON.stringify([]), JSON.stringify([]), payloadJson, JSON.stringify(["parts", "stock", "rma", "shipments"]), ...batchValues, versionId]),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    return recoverRejectedActivation(env, imports, versionId, objectKey, error);
  }
  return { versionId, recovered: false };
}

async function handleBaselineMigration(request: Request, env: CsdEnv): Promise<Response> {
  const bytes = await baselineBytes(request);
  if (bytes instanceof Response) return bytes;
  const parsed = parseBaselineMigrationWorkbook(bytes);
  if (!parsed.canCommit) return json({ detail: "首版整合檔驗證失敗", errors: parsed.errors.slice(0, MAX_MESSAGES) }, 400);
  if (await baselineAlreadyApplied(env)) return json({ detail: "首版 v0.2.2 遷移已完成，拒絕重複覆寫" }, 409);
  try {
    const activation = await stageAndActivateBaseline(env, { payload: parsed.payload, summary: parsed.summary, bytes });
    return json({ version_id: activation.versionId, recovered: activation.recovered, target: BASELINE_SOURCE_COUNTS, migration_version: "v0.2.2-baseline" }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === VERSION_PAYLOAD_LIMIT_ERROR) return json({ detail: VERSION_PAYLOAD_LIMIT_ERROR }, 413);
    if (error instanceof Error && error.message === ACTIVATION_RECONCILIATION_ERROR) return json({ detail: ACTIVATION_RECONCILIATION_ERROR }, 500);
    return json({ detail: "首版遷移儲存失敗，目前有效資料未變更" }, 500);
  }
}

async function handleBaselineReconciliation(env: CsdEnv): Promise<Response> {
  const [parts, stocks, rmas, shipments, dashboard, migration] = await Promise.all([
    statement(env, "SELECT COUNT(*) AS record_count FROM parts", []).all<{ record_count: number }>(),
    statement(env, "SELECT COUNT(*) AS record_count FROM stock_snapshots", []).all<{ record_count: number }>(),
    statement(env, "SELECT COUNT(*) AS record_count FROM rma_records", []).all<{ record_count: number }>(),
    statement(env, "SELECT COUNT(*) AS record_count FROM shipments", []).all<{ record_count: number }>(),
    getDashboardData(env),
    statement(env, `SELECT import_versions.id, import_versions.version_code FROM baseline_migrations
      JOIN import_versions ON import_versions.id = baseline_migrations.version_id
      WHERE baseline_migrations.migration_key = ? LIMIT ?`, [BASELINE_MIGRATION_KEY, 1]).all<{ id: number; version_code: string | null }>(),
  ]);
  return json({
    migrationKey: BASELINE_MIGRATION_KEY,
    migrationVersion: "v0.2.2-baseline",
    sourceSha256: BASELINE_MIGRATION_SHA256,
    versionId: migration.results?.[0]?.id ?? null,
    versionCode: migration.results?.[0]?.version_code ?? null,
    target: {
      parts: Number(parts.results?.[0]?.record_count ?? 0),
      stockRows: Number(stocks.results?.[0]?.record_count ?? 0),
      rmaRecords: Number(rmas.results?.[0]?.record_count ?? 0),
      shipmentRows: Number(shipments.results?.[0]?.record_count ?? 0),
    },
    dashboard: {
      ...dashboard.metrics,
      asOfDate: dashboard.priority_parts[0]?.as_of_date ?? null,
    },
  });
}

async function handlePreview(request: Request, env: CsdEnv): Promise<Response> {
  const input = await importForm(request);
  if (input instanceof Response) return input;
  const knownParts = await getKnownPartNumbers(env);
  const parsed = await parseUpdateWorkbook(await input.file.arrayBuffer(), input.dataType, input.mode, knownParts);
  if (!parsed.canCommit) return json(publicPreview(input.file.name, parsed));
  const prepared = await prepareImport(env, parsed);
  if (jsonByteLength(prepared.payload) > MAX_VERSION_PAYLOAD_BYTES) {
    const errors = [...prepared.parsed.errors, VERSION_PAYLOAD_LIMIT_ERROR];
    return json(publicPreview(input.file.name, {
      ...prepared.parsed,
      errors,
      summary: { ...prepared.parsed.summary, errors: errors.length },
      canCommit: false,
    }));
  }
  return json(publicPreview(input.file.name, prepared.parsed));
}

async function handleCommit(request: Request, env: CsdEnv): Promise<Response> {
  const input = await importForm(request);
  if (input instanceof Response) return input;
  const bytes = await input.file.arrayBuffer();
  const knownParts = await getKnownPartNumbers(env);
  const parsed = await parseUpdateWorkbook(bytes, input.dataType, input.mode, knownParts);
  if (!parsed.canCommit) return json({ detail: "檔案檢查未通過", ...publicPreview(input.file.name, parsed) }, 400);
  const prepared = await prepareImport(env, parsed);
  if (jsonByteLength(prepared.payload) > MAX_VERSION_PAYLOAD_BYTES) {
    return json({ detail: VERSION_PAYLOAD_LIMIT_ERROR }, 413);
  }

  try {
    const activation = await stageAndActivateImport(env, { filename: input.file.name, operator: input.operator, parsed: prepared.parsed, payload: prepared.payload, currentItems: prepared.currentItems, warnings: prepared.warnings, bytes });
    return json({ version_id: activation.versionId, recovered: activation.recovered, summary: { ...prepared.parsed.summary, stored_records: prepared.currentItems.length }, warnings: prepared.warnings.slice(0, MAX_MESSAGES) });
  } catch (error) {
    if (error instanceof Error && error.message === ACTIVATION_RECONCILIATION_ERROR) return json({ detail: ACTIVATION_RECONCILIATION_ERROR }, 500);
    return json({ detail: "儲存失敗，目前有效資料未變更" }, 500);
  }
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function attachment(filename: string, contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${safeFilename(filename)}"`,
  });
}

function numberId(value: string): number | null {
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

type VersionRow = Omit<DataVersion, "summary" | "warnings" | "errors" | "payload" | "scope"> & {
  summary_json: string; warnings_json: string; errors_json: string; payload_json: string; scope_json: string;
};

function hydrateVersion(row: VersionRow): DataVersion {
  return {
    ...row,
    summary: parseJson(row.summary_json, {}),
    warnings: parseJson(row.warnings_json, []),
    errors: parseJson(row.errors_json, []),
    payload: parseJson(row.payload_json, []),
    scope: parseJson(row.scope_json, []),
  };
}

async function activeVersion(env: CsdEnv, id: number): Promise<DataVersion | null> {
  const result = await statement(env,
    `SELECT id, data_type, import_mode, filename, stored_object_key, created_at, created_by,
      summary_json, warnings_json, errors_json, payload_json, scope_json, restored_from_id, batch_id, version_code, status
     FROM import_versions WHERE id = ? AND status = 'active'`, [id]).all<VersionRow>();
  const row = result.results?.[0];
  return row ? hydrateVersion(row) : null;
}

function zipStored(files: Array<{ name: string; bytes: ArrayBuffer }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const write32 = (view: DataView, position: number, value: number) => view.setUint32(position, value, true);
  const write16 = (view: DataView, position: number, value: number) => view.setUint16(position, value, true);
  for (const file of files) {
    const name = encoder.encode(file.name);
    const bytes = new Uint8Array(file.bytes);
    const crc = crc32(bytes);
    const header = new Uint8Array(30 + name.length + bytes.length);
    const headerView = new DataView(header.buffer);
    write32(headerView, 0, 0x04034b50); write16(headerView, 4, 20); write16(headerView, 8, 0);
    write32(headerView, 14, crc); write32(headerView, 18, bytes.length); write32(headerView, 22, bytes.length);
    write16(headerView, 26, name.length); header.set(name, 30); header.set(bytes, 30 + name.length);
    local.push(header);
    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    write32(directoryView, 0, 0x02014b50); write16(directoryView, 4, 20); write16(directoryView, 6, 20); write16(directoryView, 10, 0);
    write32(directoryView, 16, crc); write32(directoryView, 20, bytes.length); write32(directoryView, 24, bytes.length);
    write16(directoryView, 28, name.length); write32(directoryView, 42, offset); directory.set(name, 46);
    central.push(directory); offset += header.length;
  }
  const centralBytes = central.reduce((total, value) => total + value.length, 0);
  const output = new Uint8Array(offset + centralBytes + 22);
  let position = 0;
  for (const chunk of local) { output.set(chunk, position); position += chunk.length; }
  for (const chunk of central) { output.set(chunk, position); position += chunk.length; }
  const end = new DataView(output.buffer, position, 22);
  write32(end, 0, 0x06054b50); write16(end, 8, files.length); write16(end, 10, files.length); write32(end, 12, centralBytes); write32(end, 16, offset);
  return output.buffer;
}

async function handleCurrentExport(env: CsdEnv): Promise<Response> {
  const [partCount, stockCount, rmaCount] = await Promise.all([
    statement(env, "SELECT COUNT(*) AS record_count FROM parts", []).all<{ record_count: number }>(),
    statement(env, "SELECT COUNT(*) AS record_count FROM stock_snapshots", []).all<{ record_count: number }>(),
    statement(env, "SELECT COUNT(*) AS record_count FROM rma_records", []).all<{ record_count: number }>(),
  ]);
  const rows = [partCount, stockCount, rmaCount].reduce((total, result) => total + Number(result.results?.[0]?.record_count ?? 0), 0);
  if (rows > MAX_CURRENT_EXPORT_ROWS || rows * CURRENT_EXPORT_ESTIMATED_BYTES_PER_ROW > MAX_CURRENT_EXPORT_ESTIMATED_BYTES) {
    return json({ detail: "目前資料量超過匯出上限，請改用版本資料下載" }, 413);
  }
  const [parts, stocks, rmas] = await Promise.all([
    statement(env, "SELECT material_number, site, model, pn_key, pn_key2, inbound_qty, imported_planned_qty, notes FROM parts ORDER BY material_number", []).all<PartRecord>(),
    statement(env, "SELECT material_number, UPPER(TRIM(warehouse)) AS warehouse, bin_location, quantity FROM stock_snapshots ORDER BY UPPER(TRIM(warehouse)), material_number", []).all<StockRecord>(),
    statement(env, `SELECT service_date, material_number, customer, region, product_type, model_customer, model, serial_number, failure_classification
      FROM rma_records ORDER BY service_date, id`, []).all<RmaRecord>(),
  ]);
  const archive = zipStored([
    { name: "csd-current-master.xlsx", bytes: createDataWorkbook("master", parts.results ?? []) },
    { name: "csd-current-inventory.xlsx", bytes: createDataWorkbook("inventory", stocks.results ?? []) },
    { name: "csd-current-rma.xlsx", bytes: createDataWorkbook("rma", rmas.results ?? []) },
  ]);
  return new Response(archive, { headers: attachment("csd-current-data.zip", "application/zip") });
}

async function handleVersions(env: CsdEnv, searchParams: URLSearchParams): Promise<Response> {
  const dataType = searchParams.get("data_type")?.trim() ?? "";
  if (dataType && !isVersionDataType(dataType)) return json({ detail: "資料類型無效" }, 400);
  const search = searchParams.get("search")?.trim() ?? "";
  const clauses = ["status = 'active'"];
  const values: unknown[] = [];
  if (dataType) {
    clauses.push("data_type = ?");
    values.push(dataType);
  }
  if (search) {
    clauses.push("(filename LIKE ? COLLATE NOCASE OR created_by LIKE ? COLLATE NOCASE OR version_code LIKE ? COLLATE NOCASE)");
    const pattern = `%${search}%`;
    values.push(pattern, pattern, pattern);
  }
  values.push(500);
  const result = await statement(env,
    `SELECT id, data_type, import_mode, filename, stored_object_key, created_at, created_by,
      summary_json, warnings_json, errors_json, payload_json, scope_json, restored_from_id, batch_id, version_code, status
     FROM import_versions WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`, values).all<VersionRow>();
  const versions: DataVersion[] = (result.results ?? []).map((row: VersionRow) => hydrateVersion(row));
  return json({ items: versions.map((version) => {
    const { stored_object_key, payload, ...publicVersion } = version;
    return {
      ...publicVersion,
      label: publicVersion.data_type === "baseline" ? "首版整合遷移" : publicVersion.data_type === "rma" ? "RMA" : publicVersion.data_type === "inventory" ? "庫存" : "料號主檔",
      has_original: Boolean(stored_object_key), has_data_download: Array.isArray(payload), can_restore: publicVersion.data_type !== "baseline",
    };
  }) });
}

async function handleVersionFile(env: CsdEnv, id: number): Promise<Response> {
  const version = await activeVersion(env, id);
  if (!version?.stored_object_key || !env.IMPORTS) return json({ detail: "找不到版本原始檔" }, 404);
  const object = await env.IMPORTS.get(version.stored_object_key);
  if (!object) return json({ detail: "找不到版本原始檔" }, 404);
  return new Response(object.body, { headers: attachment(version.filename, object.httpMetadata?.contentType || XLSX_CONTENT_TYPE) });
}

async function handleVersionData(env: CsdEnv, id: number): Promise<Response> {
  const version = await activeVersion(env, id);
  if (!version || version.data_type === "baseline" || !Array.isArray(version.payload)) return json({ detail: "找不到版本資料" }, 404);
  return new Response(createDataWorkbook(version.data_type, version.payload), {
    headers: attachment(`csd-version-${id}-${version.data_type}.xlsx`, XLSX_CONTENT_TYPE),
  });
}

async function operatorFrom(request: Request): Promise<string> {
  try {
    const form = await request.formData();
    return String(form.get("operator") ?? "本機使用者").trim() || "本機使用者";
  } catch { return "本機使用者"; }
}

function canonicalStockRecords(records: StockRecord[]): StockRecord[] {
  const canonical = new Map<string, StockRecord>();
  for (const row of records) {
    const warehouse = normalizeWarehouseIdentifier(row.warehouse);
    const binLocation = row.bin_location?.trim().toUpperCase() || null;
    const key = JSON.stringify([warehouse, row.material_number, binLocation]);
    const existing = canonical.get(key);
    if (existing) existing.quantity += row.quantity;
    else canonical.set(key, { ...row, warehouse, bin_location: binLocation });
  }
  return [...canonical.values()];
}

function restoreStatements(env: CsdEnv, version: DataVersion, operator: string) {
  const createdAt = nowIso();
  let restoredPayload = version.payload;
  let restoredScope = version.scope;
  if (version.data_type === "inventory") {
    restoredPayload = canonicalStockRecords(version.payload as StockRecord[]);
    const storedRows = restoredPayload as StockRecord[];
    restoredScope = [...new Set((version.scope.length ? version.scope : storedRows.map((row) => row.warehouse))
      .map(normalizeWarehouseIdentifier)
      .filter(Boolean))].sort();
  }
  const payload = JSON.stringify(restoredPayload);
  const coverageMode = version.data_type === "master" ? "full" : version.import_mode;
  const statements = [statement(env, "INSERT INTO import_batches (filename, created_at, summary_json, errors_json) VALUES (?, ?, ?, ?)",
    [`回復-${version.filename}`, createdAt, JSON.stringify(version.summary), JSON.stringify(version.errors)])];
  const batchLookup = "(SELECT id FROM import_batches WHERE filename = ? AND created_at = ? ORDER BY id DESC LIMIT 1)";
  const batchValues = [`回復-${version.filename}`, createdAt];
  if (version.data_type === "inventory") {
    const storedRows = restoredPayload as StockRecord[];
    const scope = restoredScope;
    if (version.import_mode === "full") statements.push(statement(env, "DELETE FROM stock_snapshots", []));
    else if (scope.length) statements.push(statement(env, `DELETE FROM stock_snapshots WHERE UPPER(TRIM(warehouse)) IN (${scope.map(() => "?").join(", ")})`, scope));
    if (storedRows.length) statements.push(statement(env, `INSERT INTO stock_snapshots (batch_id, material_number, warehouse, bin_location, quantity)
      SELECT ${batchLookup}, json_extract(value, '$.material_number'), json_extract(value, '$.warehouse'), json_extract(value, '$.bin_location'), json_extract(value, '$.quantity') FROM json_each(?)`, [...batchValues, payload]));
  } else if (version.data_type === "rma") {
    statements.push(statement(env, "DELETE FROM rma_records", []));
    statements.push(statement(env, `INSERT INTO rma_records (batch_id, service_date, customer, region, product_type, model_customer, model, serial_number, failure_classification, material_number)
      SELECT ${batchLookup}, json_extract(value, '$.service_date'), json_extract(value, '$.customer'), json_extract(value, '$.region'), json_extract(value, '$.product_type'), json_extract(value, '$.model_customer'), json_extract(value, '$.model'), json_extract(value, '$.serial_number'), json_extract(value, '$.failure_classification'), json_extract(value, '$.material_number') FROM json_each(?)`, [...batchValues, payload]));
  } else {
    statements.push(statement(env, `INSERT INTO parts (material_number, site, model, pn_key, pn_key2, target_months, safety_months, demand_override, safety_override, active, inbound_qty, imported_planned_qty, notes, updated_at)
      SELECT json_extract(value, '$.material_number'), json_extract(value, '$.site'), json_extract(value, '$.model'), json_extract(value, '$.pn_key'), json_extract(value, '$.pn_key2'), 6, 3, NULL, NULL, 1, json_extract(value, '$.inbound_qty'), json_extract(value, '$.imported_planned_qty'), json_extract(value, '$.notes'), ? FROM json_each(?)
      ON CONFLICT(material_number) DO UPDATE SET site = excluded.site, model = excluded.model, pn_key = excluded.pn_key, pn_key2 = excluded.pn_key2, active = excluded.active, inbound_qty = excluded.inbound_qty, imported_planned_qty = excluded.imported_planned_qty, updated_at = excluded.updated_at`, [createdAt, payload]));
    if (coverageMode === "full") statements.push(statement(env,
      `UPDATE parts SET active = 0, updated_at = ?
      WHERE active <> 0 AND material_number NOT IN (
        SELECT json_extract(value, '$.material_number') FROM json_each(?)
      )`,
      [createdAt, payload],
    ));
  }
  statements.push(statement(env, `INSERT INTO import_versions (data_type, import_mode, filename, stored_object_key, created_at, created_by, summary_json, warnings_json, errors_json, payload_json, scope_json, restored_from_id, batch_id, version_code, status)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ${batchLookup}, ?, 'active')`, [version.data_type, coverageMode, `回復-${version.filename}`, createdAt, operator, JSON.stringify(version.summary), JSON.stringify(version.warnings), JSON.stringify(version.errors), payload, JSON.stringify(restoredScope), version.id, ...batchValues, versionCode(createdAt)]));
  return statements;
}

async function handleVersionRestore(request: Request, env: CsdEnv, id: number): Promise<Response> {
  const version = await activeVersion(env, id);
  if (!version || !Array.isArray(version.payload)) return json({ detail: "找不到可回復的資料版本" }, 404);
  if (version.data_type === "baseline") return json({ detail: "首版整合遷移只保留原始檔與核對結果，不支援以單一資料類型回復" }, 409);
  try {
    await env.DB.batch(restoreStatements(env, version, await operatorFrom(request)));
    return json({ message: "已回復資料版本，待生產需求與人工設定已保留" });
  } catch { return json({ detail: "回復失敗，目前有效資料未變更" }, 500); }
}

const PRODUCTION_STATUSES = new Set(["草稿", "已提出", "生產中", "已完成", "取消"]);

function validQuantity(value: unknown, nullable = false): number | null | undefined {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

async function requestJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}

function validProductionState(input: Record<string, unknown>): string | null {
  const status = String(input.status ?? "草稿");
  const expectedDate = input.expected_date === null || input.expected_date === undefined ? "" : String(input.expected_date).trim();
  const notes = input.notes === null || input.notes === undefined ? "" : String(input.notes).trim();
  if (!PRODUCTION_STATUSES.has(status)) return "生產狀態無效";
  if (status !== "草稿" && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate) || !notes)) return "非草稿狀態必須填寫預計日期與備註";
  return null;
}

async function handlePartPatch(request: Request, env: CsdEnv, materialNumber: string): Promise<Response> {
  const input = await requestJson(request);
  if (!input) return json({ detail: "設定資料格式無效" }, 400);
  const target = validQuantity(input.target_months);
  const safety = validQuantity(input.safety_months);
  const demand = validQuantity(input.demand_override, true);
  const safetyOverride = validQuantity(input.safety_override, true);
  if (target === undefined || safety === undefined || demand === undefined || safetyOverride === undefined) return json({ detail: "數量設定必須是非負數" }, 400);
  const notes = input.notes === null || input.notes === undefined ? null : String(input.notes);
  const result = await statement(env, `UPDATE parts SET target_months = ?, safety_months = ?, demand_override = ?, safety_override = ?, notes = ?, updated_at = ? WHERE material_number = ?`,
    [target, safety, demand, safetyOverride, notes, nowIso(), materialNumber]).run();
  if (!result.meta.changes) return json({ detail: "找不到料號" }, 404);
  return json({ message: "料號設定已更新" });
}

async function productionOrders(env: CsdEnv, deleted: boolean): Promise<Response> {
  const result = await statement(env, `SELECT id, material_number, suggested_qty, confirmed_qty, expected_date, status, notes, created_at, updated_at, deleted_at, deleted_by
    FROM production_orders WHERE ${deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"} ORDER BY updated_at DESC, id DESC`, []).all<ProductionOrder>();
  return json(result.results ?? []);
}

async function createProductionOrder(request: Request, env: CsdEnv): Promise<Response> {
  const input = await requestJson(request);
  if (!input || !String(input.material_number ?? "").trim()) return json({ detail: "料號不可空白" }, 400);
  const materialNumber = String(input.material_number).trim();
  const known = await statement(env, "SELECT material_number FROM parts WHERE material_number = ? AND active = ? LIMIT ?", [materialNumber, 1, 1]).all<{ material_number: string }>();
  if (!known.results?.length) return json({ detail: "找不到料號" }, 404);
  const suggested = validQuantity(input.suggested_qty);
  const confirmed = validQuantity(input.confirmed_qty, true);
  const validation = validProductionState(input);
  if (suggested === undefined || confirmed === undefined) return json({ detail: "生產數量必須是非負數" }, 400);
  if (validation) return json({ detail: validation }, 400);
  const createdAt = nowIso();
  const status = String(input.status ?? "草稿");
  const result = await statement(env, `INSERT INTO production_orders (material_number, suggested_qty, confirmed_qty, expected_date, status, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [materialNumber, suggested, confirmed, input.expected_date || null, status, input.notes ? String(input.notes).trim() : null, createdAt, createdAt]).run();
  return json({ id: Number(result.meta.last_row_id), message: "已建立待生產需求" }, 201);
}

async function updateProductionOrder(request: Request, env: CsdEnv, id: number): Promise<Response> {
  const input = await requestJson(request);
  if (!input) return json({ detail: "更新資料格式無效" }, 400);
  const existing = await statement(env, `SELECT id, material_number, suggested_qty, confirmed_qty, expected_date, status, notes, created_at, updated_at, deleted_at, deleted_by
    FROM production_orders WHERE id = ? AND deleted_at IS NULL`, [id]).all<ProductionOrder>();
  const current = existing.results?.[0];
  if (!current) return json({ detail: "找不到待生產需求" }, 404);
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  const suggested = has("suggested_qty") ? validQuantity(input.suggested_qty) : current.suggested_qty;
  const confirmed = has("confirmed_qty") ? validQuantity(input.confirmed_qty, true) : current.confirmed_qty;
  if (suggested === undefined || confirmed === undefined) return json({ detail: "生產數量必須是非負數" }, 400);
  const status = has("status") ? String(input.status) : current.status;
  const expectedDate = has("expected_date") ? (input.expected_date ? String(input.expected_date).trim() : null) : current.expected_date;
  const notes = has("notes") ? (input.notes ? String(input.notes).trim() : null) : current.notes;
  const validation = validProductionState({ status, expected_date: expectedDate, notes });
  if (validation) return json({ detail: validation }, 400);
  const result = await statement(env, `UPDATE production_orders SET suggested_qty = ?, confirmed_qty = ?, status = ?, expected_date = ?, notes = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL`, [suggested, confirmed, status, expectedDate, notes, nowIso(), id]).run();
  if (!result.meta.changes) return json({ detail: "找不到待生產需求" }, 404);
  return json({ message: "待生產需求已更新" });
}

async function deleteProductionOrder(request: Request, env: CsdEnv, id: number): Promise<Response> {
  const result = await statement(env, "UPDATE production_orders SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowIso(), await operatorFrom(request), nowIso(), id]).run();
  if (!result.meta.changes) return json({ detail: "找不到待生產需求" }, 404);
  return json({ message: "待生產需求已刪除" });
}

async function restoreProductionOrder(env: CsdEnv, id: number): Promise<Response> {
  const result = await statement(env, "UPDATE production_orders SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL", [nowIso(), id]).run();
  if (!result.meta.changes) return json({ detail: "找不到已刪除待生產需求" }, 404);
  return json({ message: "待生產需求已回復" });
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function shortageCsv(env: CsdEnv): Promise<Response> {
  const rows = (await getPlanningRows(env, { onlyShortage: true })).map((row) => [
    row.material_number, row.site, row.model, row.rma_1m, row.rma_3m, row.rma_6m, row.rma_12m,
    row.monthly_demand, row.csd_stock, row.overseas_stock,
    row.in_transit, row.pending_production, row.safety_stock, row.shortage_qty, row.suggested_production,
  ]);
  const body = `\ufeff料號,Site,機種,1M RMA,3M RMA,6M RMA,12M RMA,每月需求,CSD庫存,海外庫存,在途,待投產,安全庫存,缺料量,建議生產量\r\n${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  return new Response(body, { headers: attachment("csd-shortages.csv", "text/csv; charset=utf-8") });
}

export async function handleCsdApi(request: Request, env: CsdEnv, access?: CsdAccess): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/session") {
    if (!access) return json({ detail: "請先登入 ChatGPT" }, 401);
    return json({ email: access.email, role: access.role });
  }
  if (request.method === "GET" && url.pathname === BASELINE_CONTRACT_PATH) return baselineContractResponse();
  if (request.method === "GET" && url.pathname === BASELINE_RECONCILIATION_PATH) return handleBaselineReconciliation(env);
  if (request.method === "POST" && url.pathname === BASELINE_MIGRATION_PATH) return handleBaselineMigration(request, env);
  if (request.method === "POST" && url.pathname === "/api/data/preview") return handlePreview(request, env);
  if (request.method === "POST" && url.pathname === "/api/data/commit") return handleCommit(request, env);
  if (request.method === "GET" && url.pathname === "/api/data/export/current.zip") return handleCurrentExport(env);
  if (request.method === "GET" && url.pathname.startsWith("/api/data/templates/")) {
    const kind = url.pathname.slice("/api/data/templates/".length);
    if (!isImportKind(kind)) return json({ detail: "找不到範本" }, 404);
    return new Response(createTemplateWorkbook(kind), { headers: attachment(`csd-${kind}-template.xlsx`, XLSX_CONTENT_TYPE) });
  }
  if (request.method === "GET" && url.pathname === "/api/data/versions") return handleVersions(env, url.searchParams);
  const versionPath = url.pathname.match(/^\/api\/data\/versions\/(\d+)(?:\/(file|data|restore))?$/);
  if (versionPath) {
    const id = numberId(versionPath[1]);
    if (!id) return json({ detail: "找不到資料版本" }, 404);
    if (request.method === "GET" && versionPath[2] === "file") return handleVersionFile(env, id);
    if (request.method === "GET" && versionPath[2] === "data") return handleVersionData(env, id);
    if (request.method === "POST" && versionPath[2] === "restore") return handleVersionRestore(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/export/shortages.csv") return shortageCsv(env);
  if (request.method === "PATCH" && url.pathname.startsWith("/api/parts/")) return handlePartPatch(request, env, decodeURIComponent(url.pathname.slice("/api/parts/".length)));
  if (url.pathname === "/api/production-orders") {
    if (request.method === "GET") return productionOrders(env, false);
    if (request.method === "POST") return createProductionOrder(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/production-orders/deleted") return productionOrders(env, true);
  const orderPath = url.pathname.match(/^\/api\/production-orders\/(\d+)(?:\/restore)?$/);
  if (orderPath) {
    const id = numberId(orderPath[1]);
    if (!id) return json({ detail: "找不到待生產需求" }, 404);
    if (request.method === "PATCH" && !url.pathname.endsWith("/restore")) return updateProductionOrder(request, env, id);
    if (request.method === "DELETE" && !url.pathname.endsWith("/restore")) return deleteProductionOrder(request, env, id);
    if (request.method === "POST" && url.pathname.endsWith("/restore")) return restoreProductionOrder(env, id);
  }
  if (request.method !== "GET") return json({ detail: "找不到 API" }, 404);

  if (url.pathname === "/api/health") return json({ status: "ok" });
  if (url.pathname === "/api/dashboard") return json(await getDashboardData(env));
  if (url.pathname === "/api/parts") {
    const rows = await getPlanningRows(env, {
      search: url.searchParams.get("search") ?? "",
      site: url.searchParams.get("site") ?? "",
      onlyShortage: url.searchParams.get("only_shortage") === "true",
    });
    return json({
      items: rows,
      sites: [...new Set(rows.map((row) => row.site).filter((site): site is string => Boolean(site)))].sort(),
      as_of_date: rows[0]?.as_of_date ?? null,
    });
  }

  return json({ detail: "找不到 API" }, 404);
}
