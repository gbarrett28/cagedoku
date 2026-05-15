export interface ActionEntry {
  time: string;
  event: string;
  detail?: string;
}

const log: ActionEntry[] = [];

export function logAction(event: string, detail?: string): void {
  const entry: ActionEntry = { time: new Date().toISOString(), event };
  if (detail !== undefined) entry.detail = detail;
  log.push(entry);
}

export function getActionLog(): readonly ActionEntry[] {
  return log;
}

export function clearActionLog(): void {
  log.length = 0;
}

export function formatActionLog(): string {
  if (log.length === 0) return '(no actions recorded)';
  return log.map(e => `${e.time}  ${e.event}${e.detail !== undefined ? ' — ' + e.detail : ''}`).join('\n');
}
