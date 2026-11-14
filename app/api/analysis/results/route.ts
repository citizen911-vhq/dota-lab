import {updateMatchResults} from '@/lib/dota-result-store';
import {authorizeWrite,fail,json} from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{authorizeWrite(request);return json(await updateMatchResults());}catch(e){return fail(e);}}
