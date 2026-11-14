import { readAiDashboard, runAiReport } from '@/lib/dota-ai-store';
import { authorizeWrite, body, fail, json } from '@/lib/dota-http';
export const dynamic = 'force-dynamic';
export async function GET(r: Request) {
  try { const query = new URL(r.url).searchParams; return json(await readAiDashboard({ mode: query.get('mode') ?? 'explain', fixture_id: query.get('fixture_id') })); }
  catch (e) { return fail(e); }
}
export async function POST(r: Request) {
  try { authorizeWrite(r); return json(await runAiReport(await body(r))); }
  catch (e) { return fail(e); }
}
