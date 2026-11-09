import { confirmAnalysisSeries } from '@/lib/dota-auto-store';
import { authorizeWrite,body,fail,json } from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{authorizeWrite(request);return json(await confirmAnalysisSeries(await body(request)));}catch(e){return fail(e);}}
