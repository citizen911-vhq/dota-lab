import { readCurrentJournal } from '@/lib/dota-store';
import { fail,json } from '@/lib/dota-http';
export const dynamic = 'force-dynamic';
export async function GET() { try { return json(await readCurrentJournal()); } catch(e) { return fail(e); } }
