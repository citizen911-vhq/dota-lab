declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    OPENDOTA_API_KEY?: string;
    OPENAI_API_KEY?: string;
    ODDS_API_IO_KEY?: string;
    ODDS_API_IO_BOOKMAKERS?: string;
    AUTO_PAPER_ENABLED?: string;
    ODDSLINK_API_KEY?: string;
    ODDSLINK_MAX_REQUESTS_PER_DAY?: string;
    ODDSLINK_MAX_REQUESTS_PER_MONTH?: string;
    PAPER_MIN_ODDS?: string;
    PAPER_MIN_EV?: string;
    PAPER_PROBABILITY_RESERVE?: string;
    BUCKET?: R2Bucket;
  }
}
