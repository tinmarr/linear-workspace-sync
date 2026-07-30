export type LogFields = Record<string, unknown>;

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event,
    ...fields,
  }));
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  logEvent(event, { ...fields, level: "error", error: message });
}
