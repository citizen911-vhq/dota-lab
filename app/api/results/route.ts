import { recordResult } from '@/lib/dota-store';
import { authorizeWrite,body,fail,json } from '@/lib/dota-http';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { authorizeWrite(request,true); return json(await recordResult(await body(request)),201); } catch(e) { return fail(e); }
}
