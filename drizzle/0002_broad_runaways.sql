CREATE TABLE `baseline_migrations` (
	`migration_key` text PRIMARY KEY NOT NULL,
	`version_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `import_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `baseline_migrations_requires_empty_target`
BEFORE INSERT ON `baseline_migrations`
WHEN EXISTS (SELECT 1 FROM `parts`)
  OR EXISTS (SELECT 1 FROM `stock_snapshots`)
  OR EXISTS (SELECT 1 FROM `rma_records`)
  OR EXISTS (SELECT 1 FROM `shipments`)
  OR EXISTS (SELECT 1 FROM `production_orders`)
BEGIN
  SELECT RAISE(ABORT, 'baseline target must be empty');
END;
