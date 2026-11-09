import { savePaperSettings } from '@/lib/dota-paper-store';
import { authorizeWrite,body,fail,json } from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{authorizeWrite(request);return json(await savePaperSettings(await body(request)));}catch(e){return fail(e);}}
