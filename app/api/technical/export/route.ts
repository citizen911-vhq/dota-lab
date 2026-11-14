import { fail, json } from '@/lib/dota-http';
import { exportTechnicalJournal, technicalJournalText } from '@/lib/dota-technical-store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams, data = await exportTechnicalJournal(query.get('report_id'));
    if (query.get('format') === 'json') return json(data);
    return new Response(technicalJournalText(data), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="dota-lab-technical-log.txt"' } });
  } catch (e) { return fail(e, '/api/technical/export'); }
}
