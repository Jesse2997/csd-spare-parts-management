CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`created_at` text NOT NULL,
	`summary_json` text NOT NULL,
	`errors_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`data_type` text NOT NULL,
	`import_mode` text NOT NULL,
	`filename` text NOT NULL,
	`stored_object_key` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`summary_json` text NOT NULL,
	`warnings_json` text NOT NULL,
	`errors_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`scope_json` text DEFAULT '[]' NOT NULL,
	`restored_from_id` integer,
	`batch_id` integer,
	`version_code` text,
	FOREIGN KEY (`restored_from_id`) REFERENCES `import_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_import_versions_type_id` ON `import_versions` (`data_type`,`id`);--> statement-breakpoint
CREATE TABLE `parts` (
	`material_number` text PRIMARY KEY NOT NULL,
	`site` text,
	`model` text,
	`pn_key` text,
	`pn_key2` text,
	`target_months` real DEFAULT 6 NOT NULL,
	`safety_months` real DEFAULT 3 NOT NULL,
	`demand_override` real,
	`safety_override` real,
	`active` integer DEFAULT true NOT NULL,
	`inbound_qty` real DEFAULT 0 NOT NULL,
	`imported_planned_qty` real DEFAULT 0 NOT NULL,
	`notes` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `production_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_number` text NOT NULL,
	`suggested_qty` real NOT NULL,
	`confirmed_qty` real,
	`expected_date` text,
	`status` text DEFAULT '草稿' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`material_number`) REFERENCES `parts`(`material_number`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rma_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`service_date` text NOT NULL,
	`customer` text,
	`region` text,
	`product_type` text,
	`model_customer` text,
	`model` text,
	`serial_number` text,
	`failure_classification` text,
	`material_number` text,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rma_records_material_date` ON `rma_records` (`material_number`,`service_date`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`material_number` text NOT NULL,
	`shipment_year` integer,
	`quantity` real NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stock_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`material_number` text NOT NULL,
	`warehouse` text NOT NULL,
	`bin_location` text,
	`quantity` real NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stock_snapshots_material_number` ON `stock_snapshots` (`material_number`);