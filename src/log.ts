type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = (): number => order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 1;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < threshold()) return;
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.name : '（详见本地状态）');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}
export interface Logger { debug(m: string, e?: unknown): void; info(m: string, e?: unknown): void; warn(m: string, e?: unknown): void; error(m: string, e?: unknown): void }
export const logger = (scope: string): Logger => ({
  debug: (m, e) => emit('debug', scope, m, e),
  info: (m, e) => emit('info', scope, m, e),
  warn: (m, e) => emit('warn', scope, m, e),
  error: (m, e) => emit('error', scope, m, e),
});
