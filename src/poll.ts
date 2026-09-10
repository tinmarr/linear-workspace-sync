export function isPollDue(
  lastRunAt: number | undefined,
  now: number,
  pollIntervalSeconds: number,
  force: boolean,
  initial: boolean,
): boolean {
  if (force || initial || lastRunAt === undefined) return true;
  return now - lastRunAt >= pollIntervalSeconds * 1000;
}
