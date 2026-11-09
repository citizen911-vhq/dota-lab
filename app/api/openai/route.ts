import {openaiStatus,runOpenaiSearch} from '@/lib/dota-openai-store';
import {authorizeWrite,fail,json} from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function GET(){try{return json(await openaiStatus());}catch(e){return fail(e);}}
export async function POST(r:Request){try{authorizeWrite(r);return json(await runOpenaiSearch());}catch(e){return fail(e);}}
