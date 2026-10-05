import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from './log.js';

// Bound to 127.0.0.1 only. nginx exposes the /api/public/* routes on the
// server; everything else stays local.

const log = logger('http');

export type Handler = (url: URL, req: IncomingMessage) => unknown | Promise<unknown>;

export function startHttp(port: number, routes: Record<string, Handler>): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handler = req.method === 'GET' ? routes[url.pathname] : undefined;
    if (!handler) {
      send(res, 404, { error: 'not found' });
      return;
    }
    try {
      send(res, 200, await handler(url, req), url.pathname.startsWith('/api/public/'));
    } catch (error) {
      log.error(`${url.pathname} failed`, error);
      send(res, 500, { error: 'internal error' });
    }
  });
  server.listen(port, '127.0.0.1', () => log.info(`listening on http://127.0.0.1:${port}`));
}

function send(res: ServerResponse, status: number, body: unknown, cacheable = false): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheable ? 'public, max-age=15' : 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}
