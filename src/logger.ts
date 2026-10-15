/**
 * Minimal structured logger. Always writes to stderr so it never corrupts the
 * stdio MCP transport on stdout.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'silent') return Number.POSITIVE_INFINITY;
  return raw in order ? order[raw as Level] : order.info;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold()) return;
  const line = JSON.stringify({
    severity: level.toUpperCase(),
    time: new Date().toISOString(),
    message: msg,
    ...fields,
  });
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    write('debug', msg, fields);
  },
  info: (msg: string, fields?: Record<string, unknown>) => {
    write('info', msg, fields);
  },
  warn: (msg: string, fields?: Record<string, unknown>) => {
    write('warn', msg, fields);
  },
  error: (msg: string, fields?: Record<string, unknown>) => {
    write('error', msg, fields);
  },
};
