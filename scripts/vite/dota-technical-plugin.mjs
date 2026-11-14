import { createTechnicalBridge, TechnicalBridgeError, verifyLocalRequest } from '../dota-technical-bridge.mjs';

export function dotaTechnicalBridge() {
  return {
    name: 'dota-technical-local-archive',
    apply: 'serve',
    config() { return { server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.sites-runtime/**'] }, watch: { ignored: ['**/.sites-runtime/**'] } } }; },
    configureServer(server) {
      const bridge = createTechnicalBridge({ root: server.config.root });
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        if (!['/__dota_technical/status', '/__dota_technical/send'].includes(pathname)) return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
          if (req.url !== pathname) throw new TechnicalBridgeError('invalid_request', 'Параметры адреса не разрешены.');
          const address = server.httpServer?.address();
          if (!address || typeof address === 'string') throw new TechnicalBridgeError('not_available', 'Локальный сервер ещё не готов.', 503);
          const mutation = pathname.endsWith('/send');
          const origin = verifyLocalRequest(req, address.port, mutation);
          if (req.method !== (mutation ? 'POST' : 'GET')) throw new TechnicalBridgeError('method_not_allowed', 'Метод не поддерживается.', 405);
          if (!mutation) { res.end(JSON.stringify(await bridge.status())); return; }
          const chunks = []; let size = 0;
          const bodyDeadline = setTimeout(() => req.destroy(), 5000);
          try { for await (const chunk of req) { size += chunk.length; if (size > 1024) throw new TechnicalBridgeError('too_large', 'Запрос слишком большой.', 413); chunks.push(chunk); } }
          finally { clearTimeout(bodyDeadline); }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TechnicalBridgeError('invalid_json', 'Некорректный JSON.'); }
          res.end(JSON.stringify(await bridge.send(origin, body)));
        } catch (error) {
          res.statusCode = error instanceof TechnicalBridgeError ? error.status : 503;
          res.end(JSON.stringify({ status: 'failed', delivered: false, error: error instanceof TechnicalBridgeError ? error.code : 'archive_unavailable', reason: error instanceof TechnicalBridgeError ? error.message : 'Не удалось сохранить технический архив. Отправка не выполнена.' }));
        }
      });
    },
  };
}
