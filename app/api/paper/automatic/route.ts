import { paperAutoStatus,runPaperAuto } from '@/lib/dota-paper-auto';
import { authorizeWrite,fail,json } from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function GET(){try{return json(await paperAutoStatus());}catch(e){return fail(e);}}
export async function POST(r:Request){try{authorizeWrite(r);return json(await runPaperAuto());}catch(e){return fail(e);}}
