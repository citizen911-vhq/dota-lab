import { readCurrentJournal,readDashboard,syncJournal,recordResult } from '@/lib/dota-store';
import { authorizeWrite,body,json } from '@/lib/dota-http';
import { DataError } from '@/lib/dota-core';
import { analysisStatus,confirmAnalysisSeries,configureAnalysisSchedule,runAnalysis } from '@/lib/dota-auto-store';
import { readPaperDashboard,recordOddsQuote,recordPaperBet,savePaperSettings } from '@/lib/dota-paper-store';
export const dynamic = 'force-dynamic';
const tools = [
  {name:'read_paper_dashboard',description:'Read real manually captured odds and simulated bets, realized profit, ROI, available virtual bank and historical drawdown. Recalculates from verified result observations. Does not fetch bookmaker odds or place actual bets. Empty history is not evidence of profitability.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'save_paper_settings',description:'Set virtual starting bank and default stake in units (not money). Starting bank becomes immutable after the first paper bet. Default stake can still change. Does not transfer funds.',inputSchema:{type:'object',properties:{initial_bankroll:{type:'number',minimum:0.01,maximum:1000000},default_stake:{type:'number',minimum:0.01,maximum:1000000}},required:['initial_bankroll','default_stake'],additionalProperties:false}},
  {name:'record_odds_quote',description:'Record a real observed decimal bookmaker quote for an existing future forecast. Verify exact market, map number, threshold and settlement rules match, including duration 41:00 boundary. Require source URL and actual observed time; never invent odds, use stale search snippets or reconstruct historical prices. Registration must occur before series start and any result. Immutable quote; reuse quote_id for retries. Does not create a stake or fetch prices automatically.',inputSchema:{type:'object',properties:{quote_id:{type:'string'},forecast_id:{type:'string'},bookmaker:{type:'string'},decimal_odds:{type:'number',minimum:1.01,maximum:1000},observed_utc:{type:'string'},source_url:{type:'string'},source_market_label:{type:'string'}},required:['forecast_id','bookmaker','decimal_odds','observed_utc','source_url'],additionalProperties:false}},
  {name:'record_paper_bet',description:'Register an immutable SIMULATED stake using a saved real quote at most 10 minutes old, before series start and before any result. Requires the current patch and confirmed unchanged rosters, odds >= 1.8 and conservative positive EV; one bet per forecast; sufficient available virtual bank required. Captures current model probability and saved odds. Reuse bet_id for retries. Does not log in to a bookmaker, spend money or place an actual bet.',inputSchema:{type:'object',properties:{bet_id:{type:'string'},quote_id:{type:'string'},stake:{type:'number',minimum:0.01,maximum:1000000}},required:['quote_id'],additionalProperties:false}},
  {name:'confirm_series',description:'Confirm a finished official BO3 using an explicitly verified CyberScore or Liquipedia result and the complete ordered list of Valve map IDs already collected by run_analysis. Validates every map, score, teams and ordering, then enriches future BO3 statistics and settles matching saved forecasts. Do not infer a 2:0 from an incomplete index. Opponents outside the eight tracked teams are allowed. Does not overwrite conflicts or void decisions.',inputSchema:{type:'object',properties:{team_a_id:{type:'string'},team_b_id:{type:'string'},map_ids:{type:'array',minItems:2,maxItems:3,items:{type:'string'}},score:{type:'array',minItems:2,maxItems:2,items:{type:'integer'}},source_url:{type:'string'},verified_at:{type:'string'}},required:['team_a_id','team_b_id','map_ids','score','source_url','verified_at'],additionalProperties:false}},
  {name:'analysis_status',description:'Read server collection health, last run, missing data, team IDs, pending official-result checks, saved schedule status and cloud updater instructions. Does not run collection.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'run_analysis',description:'Run the bounded server-side Dota data collector and deterministic statistical forecasts. Preserves existing forecasts, skips started matches, partial collection or unknown current patch. Roster changes and missing lineup proof are informational only. Optionally provide independently verified future BO2 or BO3 fixtures from public CyberScore or Liquipedia to supplement the incomplete open calendar. No OpenAI API key or bookmaker odds needed. Sources must explicitly confirm the schedule; never invent fixtures.',inputSchema:{type:'object',properties:{fixtures:{type:'array',maxItems:30,items:{type:'object',properties:{team_a_id:{type:'string'},team_b_id:{type:'string'},scheduled_start_utc:{type:'string'},source_url:{type:'string'},best_of:{type:'integer',enum:[2,3]},status:{type:'string',enum:['scheduled']},verified_at:{type:'string'},provider_id:{type:'string'},league_id:{type:'string'},league:{type:'string'},patch_id:{type:'string'},rosters:{type:'object',properties:{team_a:{type:'object'},team_b:{type:'object'}},required:['team_a','team_b']}},required:['team_a_id','team_b_id','scheduled_start_utc','source_url','best_of','status','verified_at'],additionalProperties:false}}},additionalProperties:false}},
  {name:'configure_automation',description:'Record the ID and timing of an already saved Sites cloud schedule in the dashboard. This does not create or enable a scheduler. Call only after the scheduling tool confirms the schedule; never mark active based on intent alone.',inputSchema:{type:'object',properties:{enabled:{type:'boolean'},id:{type:'string'},time:{type:'string',enum:['17:00']},timezone:{type:'string',enum:['Asia/Yakutsk']},until:{type:'string',enum:['2026-12-08']}},required:['enabled'],additionalProperties:false}},
  {name:'read_dashboard',description:'Read Dota forecast outcomes, probabilities, match statistics and current test metrics. Does not modify records.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'read_journal',description:'Read the current November 14 experiment journal and its result observations. Historical journal records are not exposed.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'sync_journal',description:'Import a confirmed forecast snapshot and append verified observations. Existing forecast IDs are immutable; existing result IDs cannot be overwritten. Pull read_journal first to preserve manual observations. Never invent results or register forecasts after a match starts.',inputSchema:{type:'object',properties:{journal:{type:'object',properties:{forecasts:{type:'array',items:{type:'object'}},observations:{type:'array',items:{type:'object'}},teams:{type:'array',items:{type:'object'}},protocol:{type:'object'},metadata:{type:'object'},durationSupplement:{type:['object','null']}},required:['forecasts','observations','teams','protocol','metadata']}},required:['journal'],additionalProperties:false}},
  {name:'record_result',description:'Append a verified official series or first-map result, including source URLs. Corrections must supersede the latest observation ID. Never create a result before match start.',inputSchema:{type:'object',properties:{fixture_id:{type:'string'},series_score:{type:'array',items:{type:'number'},minItems:2,maxItems:2},map1:{type:'object',properties:{match_id:{type:['string','number','null']},kills_a:{type:'integer'},kills_b:{type:'integer'},duration_seconds:{type:'integer'}}},sources:{type:'array',items:{type:'string'},minItems:1},supersedes:{type:'string'},series_void:{type:'boolean'},map1_void:{type:'boolean'},note:{type:'string'}},required:['fixture_id','sources'],additionalProperties:false}},
];
export async function POST(request: Request) {
  let id: unknown = null;
  try {
    const rpc = await body(request) as {id?:unknown;method?:string;params?:{name?:string;arguments?:Record<string,unknown>}};
    id = rpc.id ?? null;
    const wrap = (result: unknown) => json({jsonrpc:'2.0',id,result});
    if (rpc.method === 'server/discover') return wrap({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
    if (rpc.method === 'initialize') return wrap({protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'Dota Lab',version:'1.0.0'}});
    if (rpc.method === 'notifications/initialized') return new Response(null,{status:204});
    if (rpc.method === 'tools/list') return wrap({tools});
    if (rpc.method === 'tools/call') {
      let result: unknown;
      try {
        const name = rpc.params?.name; const args = rpc.params?.arguments ?? {};
        if (name === 'read_dashboard') result = await readDashboard();
        else if (name === 'read_paper_dashboard') result = await readPaperDashboard();
        else if (name === 'save_paper_settings') { authorizeWrite(request); result = await savePaperSettings(args); }
        else if (name === 'record_odds_quote') { authorizeWrite(request); result = await recordOddsQuote(args,'agent'); }
        else if (name === 'record_paper_bet') { authorizeWrite(request); result = await recordPaperBet(args); }
        else if (name === 'analysis_status') result = await analysisStatus();
        else if (name === 'confirm_series') { authorizeWrite(request); result = await confirmAnalysisSeries(args); }
        else if (name === 'run_analysis') { authorizeWrite(request); result = await runAnalysis(args); }
        else if (name === 'configure_automation') { authorizeWrite(request); result = await configureAnalysisSchedule(args); }
        else if (name === 'read_journal') result = await readCurrentJournal();
        else if (name === 'sync_journal') { authorizeWrite(request); result = await syncJournal(args.journal); }
        else if (name === 'record_result') { authorizeWrite(request); result = await recordResult(args); }
        else throw new DataError('Неизвестный инструмент.');
        return wrap({content:[{type:'text',text:JSON.stringify(result)}]});
      } catch(e) { return wrap({isError:true,content:[{type:'text',text:e instanceof DataError ? e.message : 'Не удалось выполнить операцию журнала.'}]}); }
    }
    return json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
  } catch(e) { return json({jsonrpc:'2.0',id,error:{code:-32602,message:e instanceof DataError ? e.message : 'Invalid request'}}); }
}
