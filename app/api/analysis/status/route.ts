import { analysisStatus } from '@/lib/dota-auto-store';
import { fail,json } from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function GET(){try{return json(await analysisStatus());}catch(e){return fail(e);}}
