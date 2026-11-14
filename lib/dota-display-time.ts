// Presentation only. Never use these helpers to move saved events or experiment boundaries.
export const DISPLAY_TIME_ZONE = 'Europe/Moscow';
const DISPLAY_OFFSET_MS = 3 * 3_600_000;

export function displayDateTimeInput(now = Date.now()): string {
  return new Date(now + DISPLAY_OFFSET_MS).toISOString().slice(0, 19);
}

export function parseDisplayDateTimeInput(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return new Date(NaN);
  const normalized = value.length === 16 ? value + ':00' : value;
  const date = new Date(normalized + '+03:00');
  if (!Number.isFinite(date.getTime()) || displayDateTimeInput(date.getTime()) !== normalized) return new Date(NaN);
  return date;
}

export function displayDay(value: string): string {
  return new Date(Date.parse(value) + DISPLAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** Show an existing fixed-zone schedule in MSK without editing that schedule. */
export function displayScheduleTime(time: string, sourceZone: string): string | null {
  const offsets: Record<string, number> = { 'Asia/Yakutsk': 9, 'Europe/Moscow': 3, UTC: 0 };
  const match = /^(\d{2}):(\d{2})$/.exec(time), offset = offsets[sourceZone];
  if (!match || offset === undefined || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  const minutes = (Number(match[1]) * 60 + Number(match[2]) + (3 - offset) * 60 + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
