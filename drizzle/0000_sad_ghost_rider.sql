CREATE TABLE `dota_forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`registered_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dota_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dota_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`previous_id` text DEFAULT '' NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`recorded_utc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dota_observation_chain` ON `dota_observations` (`fixture_id`,`previous_id`);