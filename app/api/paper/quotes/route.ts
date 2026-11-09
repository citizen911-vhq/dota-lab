import { recordOddsQuote } from '@/lib/dota-paper-store';
import { authorizeWrite,body,fail,json } from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{authorizeWrite(request);return json(await recordOddsQuote(await body(request),request.headers.get('origin')?'manual':'agent'),201);}catch(e){return fail(e);}}
