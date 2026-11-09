import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const forecasts = sqliteTable('dota_forecasts', {
  id: text('id').primaryKey(), fixtureId: text('fixture_id').notNull(),
  payload: text('payload').notNull(), contentHash: text('content_hash').notNull(),
  registeredUtc: text('registered_utc').notNull(),
});

export const observations = sqliteTable('dota_observations', {
  id: text('id').primaryKey(), fixtureId: text('fixture_id').notNull(),
  previousId: text('previous_id').notNull().default(''),
  payload: text('payload').notNull(), contentHash: text('content_hash').notNull(),
  recordedUtc: text('recorded_utc').notNull(),
}, t => [uniqueIndex('dota_observation_chain').on(t.fixtureId, t.previousId)]);

export const metadata = sqliteTable('dota_metadata', {
  key: text('key').primaryKey(), payload: text('payload').notNull(),
  updatedUtc: text('updated_utc').notNull(),
});

export const analysisRecords = sqliteTable('dota_analysis_records', {
  key: text('key').primaryKey(), payload: text('payload').notNull(), updatedUtc: text('updated_utc').notNull(),
});
export const analysisRuns = sqliteTable('dota_analysis_runs', {
  id: text('id').primaryKey(), startedUtc: text('started_utc').notNull(),
  finishedUtc: text('finished_utc'), status: text('status').notNull(), payload: text('payload').notNull(),
});
export const analysisLease = sqliteTable('dota_analysis_lease', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), expiresAt: integer('expires_at').notNull(),
});

export const paperSettings = sqliteTable('dota_paper_settings', {
  id: text('id').primaryKey(), payload: text('payload').notNull(), updatedUtc: text('updated_utc').notNull(),
});
export const oddsQuotes = sqliteTable('dota_odds_quotes', {
  id: text('id').primaryKey(), forecastId: text('forecast_id').notNull(),
  payload: text('payload').notNull(), contentHash: text('content_hash').notNull(), recordedUtc: text('recorded_utc').notNull(),
});
export const paperBets = sqliteTable('dota_paper_bets', {
  id: text('id').primaryKey(), forecastId: text('forecast_id').notNull(),
  quoteId: text('quote_id').notNull().references(()=>oddsQuotes.id),
  payload: text('payload').notNull(), contentHash: text('content_hash').notNull(), placedUtc: text('placed_utc').notNull(),
},t=>[uniqueIndex('dota_paper_one_bet_per_forecast').on(t.forecastId)]);
