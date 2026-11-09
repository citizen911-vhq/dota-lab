declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    OPENDOTA_API_KEY?: string;
    OPENAI_API_KEY?: string;
    ODDS_API_IO_KEY?: string;
    ODDS_API_IO_BOOKMAKERS?: string;
    AUTO_PAPER_ENABLED?: string;
    BUCKET?: R2Bucket;
  }
}
