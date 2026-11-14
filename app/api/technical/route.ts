import { authorizeWrite, body, fail, json } from '@/lib/dota-http';
import { DataError } from '@/lib/dota-core';
import { captureBrowserErrors } from '@/lib/dota-technical-log';
import { readTechnicalDashboard, runTechnicalExplanation } from '@/lib/dota-technical-store';
export const dynamic = 'force-dynamic';
export async function GET() { try { return json(await readTechnicalDashboard()); } catch (e) { return fail(e, '/api/technical'); } }
export async function POST(request: Request) {
  try {
    authorizeWrite(request);
    const value = await body(request) as { action?: string } | null;
    if (value?.action === 'capture') return json(await captureBrowserErrors(value));
    if (value?.action === 'explain') return json(await runTechnicalExplanation(value));
    throw new DataError('Неизвестное действие технического журнала.');
  } catch (e) { return fail(e, '/api/technical'); }
}
