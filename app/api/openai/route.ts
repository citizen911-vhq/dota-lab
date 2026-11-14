import {openaiStatus,runOpenaiSearch} from '@/lib/dota-openai-store';
import {authorizeWrite,body,fail,json} from '@/lib/dota-http';
import {refreshOptions} from '@/lib/dota-refresh-options';
export const dynamic='force-dynamic';
export async function GET(){try{return json(await openaiStatus());}catch(e){return fail(e);}}
export async function POST(r:Request){try{authorizeWrite(r);const options=refreshOptions(r.body?await body(r):{});return json(await runOpenaiSearch(options));}catch(e){return fail(e);}}
