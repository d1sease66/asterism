import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { logger } from './log.js';

// Bound to 127.0.0.1 only. On the server nginx exposes the site and the
// /api/public/* routes; /api/stats and /health stay local.

const log = logger('http');

export type Handler = (url: URL, req: IncomingMessage) => unknown | Promise<unknown>;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function startHttp(port: number, routes: Record<string, Handler>, staticDir?: string): void {
  const root = staticDir ? resolve(staticDir) : undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }
    const handler = routes[url.pathname];
    if (handler) {
      try {
        send(res, 200, await handler(url, req), url.pathname.startsWith('/api/public/'));
      } catch (error) {
        log.error(`${url.pathname} failed`, error);
        send(res, 500, { error: 'internal error' });
      }
      return;
    }
    if (root && !url.pathname.startsWith('/api/') && serveStatic(root, url.pathname, res)) return;
    send(res, 404, { error: 'not found' });
  });
  server.listen(port, '127.0.0.1', () => log.info(`listening on http://127.0.0.1:${port}`));
}

function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  let path = normalize(join(root, decodeURIComponent(pathname)));
  if (path !== root && !path.startsWith(root + sep)) return false;
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) return false;
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(res);
  return true;
}

function send(res: ServerResponse, status: number, body: unknown, cacheable = false): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheable ? 'public, max-age=15' : 'no-store',
  });
  res.end(JSON.stringify(body));
}
