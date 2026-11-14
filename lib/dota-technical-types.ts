export type TechnicalSource = 'server' | 'browser' | 'provider';
export type TechnicalSeverity = 'error' | 'warning';
export type TechnicalInput = { source: TechnicalSource; severity?: TechnicalSeverity; code: string; message: string; details?: string; route?: string | null };
export type TechnicalEvent = {
  id: string; project: 'dota-lab'; source: TechnicalSource; severity: TechnicalSeverity;
  code: string; message: string; details: string; route: string | null;
  first_seen: string; last_seen: string; count: number;
};
export type TechnicalReport = {
  id: string; created_at: string; context_at: string; event_ids: string[]; events: TechnicalEvent[];
  status: 'completed' | 'blocked'; text: string; reason: string; input_tokens: number; output_tokens: number;
};
export type TechnicalDashboard = {
  project: 'dota-lab'; title: string; generated_at: string; key_configured: boolean;
  events: TechnicalEvent[]; reports: TechnicalReport[]; retention: { max_events: number; max_reports: number };
  delivery: { configured: boolean; thread_id: string | null; thread_title: string; mode: 'manual_export' | 'local_bridge'; reason: string };
};
