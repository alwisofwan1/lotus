// Defensive readers for SDK messages: the SDK's shapes change between versions, so nothing is
// trusted to have the type its docs promise.

export type Obj = Record<string, unknown>;

export const asObj = (value: unknown): Obj | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
export const asStr = (value: unknown): string | null => (typeof value === "string" ? value : null);
export const asNum = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
