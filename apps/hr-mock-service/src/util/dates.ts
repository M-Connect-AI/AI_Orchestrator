export function inclusiveDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const ms = b.getTime() - a.getTime();
  if (Number.isNaN(ms) || ms < 0) return -1;
  return Math.floor(ms / 86400000) + 1;
}

export function overlaps(fromA: string, toA: string, fromB: string, toB: string) {
  return fromA <= toB && fromB <= toA;
}
