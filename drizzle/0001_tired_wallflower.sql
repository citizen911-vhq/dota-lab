CREATE TABLE `dota_analysis_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dota_analysis_records` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dota_analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_utc` text NOT NULL,
	`finished_utc` text,
	`status` text NOT NULL,
	`payload` text NOT NULL
);
