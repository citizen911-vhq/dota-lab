CREATE TABLE `dota_odds_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`forecast_id` text NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`recorded_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dota_paper_bets` (
	`id` text PRIMARY KEY NOT NULL,
	`forecast_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`placed_utc` text NOT NULL,
	FOREIGN KEY (`quote_id`) REFERENCES `dota_odds_quotes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dota_paper_one_bet_per_forecast` ON `dota_paper_bets` (`forecast_id`);--> statement-breakpoint
CREATE TABLE `dota_paper_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_utc` text NOT NULL
);
