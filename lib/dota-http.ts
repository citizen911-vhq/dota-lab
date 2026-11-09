import { DataError } from './dota-core';
export function json(value: unknown, status = 200) {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export function fail(e: unknown) {
  if (e instanceof DataError) return json({error:e.message},e.status);
  console.error('Dota journal request failed',e instanceof Error ? e.message : 'Unknown error');
  return json({error:'Не удалось прочитать или сохранить журнал. Повторите попытку.'},500);
}
export async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new DataError('Используйте Content-Type: application/json.',415);
  if (Number(request.headers.get('content-length')) > 4_000_000) throw new DataError('Файл больше 4 МБ.',413);
  const content = await request.text();
  if (new TextEncoder().encode(content).length > 4_000_000) throw new DataError('Файл больше 4 МБ.',413);
  try { return JSON.parse(content); } catch { throw new DataError('Не удалось прочитать JSON.'); }
}
export function authorizeWrite(request: Request, browserOnly = false) {
  const origin = request.headers.get('origin');
  const site = new URL(request.url).origin;
  if (origin && origin !== site) throw new DataError('Запрос с другого сайта отклонён.',403);
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new DataError('Запрос с другого сайта отклонён.',403);
  if ((browserOnly || origin) && !request.headers.get('oai-authenticated-user-id')) throw new DataError('Войдите в приложение через ChatGPT.',401);
  // No-Origin service calls to /api/sync are protected by the owner-private
  // Sites dispatch boundary. Dispatch consumes OAI-Sites-Authorization before
  // forwarding and does not synthesize a visitor identity. Never publish this
  // shared writer with a public audience without adding its own authorization.
}
