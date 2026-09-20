export type LogLevel = 'info' | 'warn' | 'error';

export function structuredLog(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  });
  if (level === 'error') console.error(record);
  else if (level === 'warn') console.warn(record);
  else console.log(record);
}
