export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix = "id"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
