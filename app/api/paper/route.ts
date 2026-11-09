import { readPaperDashboard } from '@/lib/dota-paper-store';
import { fail,json } from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function GET(){try{return json(await readPaperDashboard());}catch(e){return fail(e);}}
