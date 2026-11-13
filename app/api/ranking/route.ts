import {readTeamRanking} from '@/lib/dota-auto-store';
import {json,fail} from '@/lib/dota-http';
export const dynamic='force-dynamic';
export async function GET(){try{return json(await readTeamRanking());}catch(e){return fail(e);}}
