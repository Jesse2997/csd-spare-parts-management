import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  createdAt: text("created_at").notNull(),
  summaryJson: text("summary_json").notNull(),
  errorsJson: text("errors_json").notNull(),
});

export const parts = sqliteTable("parts", {
  materialNumber: text("material_number").primaryKey(),
  site: text("site"),
  model: text("model"),
  pnKey: text("pn_key"),
  pnKey2: text("pn_key2"),
  targetMonths: real("target_months").notNull().default(6),
  safetyMonths: real("safety_months").notNull().default(3),
  demandOverride: real("demand_override"),
  safetyOverride: real("safety_override"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  inboundQty: real("inbound_qty").notNull().default(0),
  importedPlannedQty: real("imported_planned_qty").notNull().default(0),
  notes: text("notes"),
  updatedAt: text("updated_at").notNull(),
});

export const stockSnapshots = sqliteTable(
  "stock_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    batchId: integer("batch_id").notNull().references(() => importBatches.id),
    materialNumber: text("material_number").notNull(),
    warehouse: text("warehouse").notNull(),
    binLocation: text("bin_location"),
    quantity: real("quantity").notNull(),
  },
  (table) => [
    index("idx_stock_snapshots_material_number").on(table.materialNumber),
    uniqueIndex("idx_stock_snapshots_identity").on(
      sql`UPPER(TRIM(${table.warehouse}))`,
      table.materialNumber,
      sql`UPPER(TRIM(COALESCE(${table.binLocation}, '')))`,
    ),
  ],
);

export const rmaRecords = sqliteTable(
  "rma_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    batchId: integer("batch_id").notNull().references(() => importBatches.id),
    serviceDate: text("service_date").notNull(),
    customer: text("customer"),
    region: text("region"),
    productType: text("product_type"),
    modelCustomer: text("model_customer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    failureClassification: text("failure_classification"),
    materialNumber: text("material_number"),
  },
  (table) => [index("idx_rma_records_material_date").on(table.materialNumber, table.serviceDate)],
);

export const shipments = sqliteTable("shipments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id").notNull().references(() => importBatches.id),
  materialNumber: text("material_number").notNull(),
  shipmentYear: integer("shipment_year"),
  quantity: real("quantity").notNull(),
});

export const productionOrders = sqliteTable("production_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  materialNumber: text("material_number").notNull().references(() => parts.materialNumber),
  suggestedQty: real("suggested_qty").notNull(),
  confirmedQty: real("confirmed_qty"),
  expectedDate: text("expected_date"),
  status: text("status").notNull().default("草稿"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  deletedBy: text("deleted_by"),
});

export const importVersions = sqliteTable(
  "import_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dataType: text("data_type").notNull(),
    importMode: text("import_mode").notNull(),
    filename: text("filename").notNull(),
    storedObjectKey: text("stored_object_key"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    summaryJson: text("summary_json").notNull(),
    warningsJson: text("warnings_json").notNull(),
    errorsJson: text("errors_json").notNull(),
    payloadJson: text("payload_json").notNull(),
    scopeJson: text("scope_json").notNull().default("[]"),
    restoredFromId: integer("restored_from_id").references((): AnySQLiteColumn => importVersions.id),
    batchId: integer("batch_id").references(() => importBatches.id),
    versionCode: text("version_code"),
    status: text("status").notNull().default("active"),
  },
  (table) => [index("idx_import_versions_type_id").on(table.dataType, table.id)],
);

export const baselineMigrations = sqliteTable("baseline_migrations", {
  migrationKey: text("migration_key").primaryKey(),
  versionId: integer("version_id").notNull().references(() => importVersions.id),
  createdAt: text("created_at").notNull(),
});
