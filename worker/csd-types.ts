export type ImportKind = "rma" | "inventory" | "master";
export type ImportMode = "full" | "incremental" | "partial" | "restore" | "baseline";
export type VersionDataType = ImportKind | "baseline";

export type ImportPreview = {
  filename: string;
  dataType: ImportKind;
  mode: ImportMode;
  summary: Record<string, number>;
  errors: string[];
  warnings: string[];
  scope: string[];
  canCommit: boolean;
};

export type PartRecord = {
  material_number: string;
  site: string | null;
  model: string | null;
  pn_key: string | null;
  pn_key2: string | null;
  target_months: number;
  safety_months: number;
  demand_override: number | null;
  safety_override: number | null;
  active: boolean;
  inbound_qty: number;
  imported_planned_qty: number;
  notes: string | null;
  updated_at: string;
};

export type StockRecord = {
  id?: number;
  batch_id?: number;
  material_number: string;
  warehouse: string;
  bin_location: string | null;
  quantity: number;
};

export type RmaRecord = {
  id?: number;
  batch_id?: number;
  service_date: string;
  customer: string | null;
  region: string | null;
  product_type: string | null;
  model_customer: string | null;
  model: string | null;
  serial_number: string | null;
  failure_classification: string | null;
  material_number: string | null;
};

export type ShipmentRecord = {
  id?: number;
  batch_id?: number;
  material_number: string;
  shipment_year: number | null;
  quantity: number;
};

export type BaselineMigrationPayload = {
  parts: PartRecord[];
  stocks: StockRecord[];
  rmas: RmaRecord[];
  shipments: ShipmentRecord[];
};

export type ProductionOrder = {
  id: number;
  material_number: string;
  suggested_qty: number;
  confirmed_qty: number | null;
  expected_date: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
};

export type PlanningRow = PartRecord & {
  rma_1m: number;
  rma_3m: number;
  rma_6m: number;
  rma_12m: number;
  as_of_date: string;
  monthly_demand: number;
  target_stock: number;
  safety_stock: number;
  csd_stock: number;
  overseas_stock: number;
  in_transit: number;
  pending_production: number;
  available_csd: number;
  shortage_qty: number;
  suggested_production: number;
  priority_score: number;
};

export type DataVersion = {
  id: number;
  version_code: string | null;
  data_type: VersionDataType;
  import_mode: ImportMode;
  filename: string;
  stored_object_key: string | null;
  created_at: string;
  created_by: string;
  summary: Record<string, number>;
  warnings: string[];
  errors: string[];
  payload: PartRecord[] | StockRecord[] | RmaRecord[] | BaselineMigrationPayload;
  scope: string[];
  restored_from_id: number | null;
  batch_id: number | null;
  status: "active" | "pending" | "failed";
};
