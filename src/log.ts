// Tiny leveled logger. journald adds timestamps on the server, local runs
// get an ISO prefix so a long session can be read back.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? ORDER.info;
const stamp = process.env.INVOCATION_ID ? () => '' : () => `${new Date().toISOString()} `;

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const tail = extra === undefined ? '' : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  const line = `${stamp()}${level.toUpperCase().padEnd(5)} [${scope}] ${message}${tail}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => write('debug', scope, message, extra),
    info: (message: string, extra?: unknown) => write('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => write('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => write('error', scope, message, extra),
  };
}
