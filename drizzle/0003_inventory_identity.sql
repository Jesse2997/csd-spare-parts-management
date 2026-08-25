UPDATE `stock_snapshots` AS `target`
SET `quantity` = (
  SELECT SUM(`source`.`quantity`)
  FROM `stock_snapshots` AS `source`
  WHERE `source`.`material_number` = `target`.`material_number`
    AND UPPER(TRIM(`source`.`warehouse`)) = UPPER(TRIM(`target`.`warehouse`))
    AND UPPER(TRIM(COALESCE(`source`.`bin_location`, ''))) = UPPER(TRIM(COALESCE(`target`.`bin_location`, '')))
)
WHERE `target`.`id` = (
  SELECT MIN(`source`.`id`)
  FROM `stock_snapshots` AS `source`
  WHERE `source`.`material_number` = `target`.`material_number`
    AND UPPER(TRIM(`source`.`warehouse`)) = UPPER(TRIM(`target`.`warehouse`))
    AND UPPER(TRIM(COALESCE(`source`.`bin_location`, ''))) = UPPER(TRIM(COALESCE(`target`.`bin_location`, '')))
);--> statement-breakpoint
DELETE FROM `stock_snapshots`
WHERE `id` NOT IN (
  SELECT MIN(`id`)
  FROM `stock_snapshots`
  GROUP BY `material_number`, UPPER(TRIM(`warehouse`)), UPPER(TRIM(COALESCE(`bin_location`, '')))
);--> statement-breakpoint
UPDATE `stock_snapshots`
SET `warehouse` = UPPER(TRIM(`warehouse`)),
  `bin_location` = NULLIF(UPPER(TRIM(COALESCE(`bin_location`, ''))), '');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_snapshots_identity`
ON `stock_snapshots` (UPPER(TRIM(`warehouse`)), `material_number`, UPPER(TRIM(COALESCE(`bin_location`, ''))));
