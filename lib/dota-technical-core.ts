import { DataError } from './dota-core';
import type { TechnicalInput } from './dota-technical-types';

export const TECHNICAL_PROJECT = 'dota-lab' as const;
export const TECHNICAL_MAX_EVENTS = 500;
export const TECHNICAL_MAX_REPORTS = 50;
const HIDDEN = '[скрыто]';

// Never serialize environment, request headers, cookies or entire arbitrary objects.
// These are defence-in-depth filters for bounded text, not a promise to identify all PII.
export function redactTechnicalText(value: unknown, max = 6000, secrets: readonly string[] = []): string {
  if (typeof value !== 'string') return '';
  let text = value.slice(0, 20000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret.trim()) continue;
    for (const form of new Set([secret, secret.trim(), encodeURIComponent(secret), encodeURIComponent(secret.trim())])) text = text.split(form).join(HIDDEN);
  }
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, HIDDEN)
    .replace(/^(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:)[^\r\n]*/gim, '$1 ' + HIDDEN)
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?):\/\/[^\s<>"']+/gi, '[connection-string]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '[authorization hidden]')
    .replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, HIDDEN)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, raw => {
      try { const u = new URL(raw); u.username = ''; u.password = ''; if (u.search) u.search = '?[query-hidden]'; u.hash = ''; return u.toString(); }
      catch { return '[url hidden]'; }
    })
    .replace(/((?:["']?(?:[A-Z0-9_-]{0,80}(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|connection[_-]?string)[A-Z0-9_-]{0,80})["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1' + HIDDEN)
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s<>"')]+/g, '[private-path]')
    .replace(/[A-Z]:\\Users\\[^\s<>"')]+/gi, '[private-path]')
    .replace(/\/var\/folders\/[^\s<>"')]+/g, '[temporary-path]');
  return text.slice(0, max);
}

export function technicalRoute(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, 'http://dota-lab.local');
    if (!/^https?:$/.test(url.protocol)) return null;
    return redactTechnicalText(url.pathname, 300);
  } catch { return null; }
}

export function normalizeTechnicalInput(input: TechnicalInput, secrets: readonly string[] = []): Required<TechnicalInput> {
  return {
    source: ['server', 'browser', 'provider'].includes(input.source) ? input.source : 'server',
    severity: input.severity === 'warning' ? 'warning' : 'error',
    code: redactTechnicalText(input.code, 80, secrets).replace(/[^a-zA-Z0-9_.:-]/g, '_') || 'UNEXPECTED_ERROR',
    message: redactTechnicalText(input.message, 1000, secrets) || 'Неизвестная техническая ошибка.',
    details: redactTechnicalText(input.details, 6000, secrets),
    route: technicalRoute(redactTechnicalText(input.route, 1000, secrets)),
  };
}

export function technicalFailure(error: unknown, route?: string): TechnicalInput | null {
  if (error instanceof DataError && error.status < 500) return null;
  return { source: 'server', severity: 'error', code: error instanceof DataError ? `HTTP_${error.status}` : 'UNHANDLED_SERVER_ERROR',
    message: error instanceof Error ? error.message : 'Неизвестное исключение сервера.',
    details: error instanceof Error ? error.stack : undefined, route };
}

export function browserTechnicalInputs(input: unknown): TechnicalInput[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DataError('Некорректный пакет технических ошибок.');
  const events = (input as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 10) throw new DataError('Принимается от 1 до 10 ошибок за запрос.');
  return events.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DataError('Некорректная техническая ошибка.');
    const row = item as Record<string, unknown>;
    for (const [field, max] of [['code', 80], ['message', 1000], ['details', 6000], ['route', 1000]] as const) {
      const v = row[field];
      if (v == null && (field === 'details' || field === 'route')) continue;
      if (typeof v !== 'string' || v.length > max || ((field === 'code' || field === 'message') && !v.trim())) throw new DataError('Некорректное поле технической ошибки: ' + field);
    }
    if (row.severity != null && !['error', 'warning'].includes(String(row.severity))) throw new DataError('Некорректная важность технической ошибки.');
    // Browser cannot claim server provenance or supply ID, project, counts or timestamps.
    return { source: 'browser', code: row.code as string, message: row.message as string, details: row.details as string | undefined, route: row.route as string | null | undefined, severity: row.severity as 'error' | 'warning' | undefined };
  });
}
