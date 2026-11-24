"use client";

export const MIN_TERMINAL_TRACK_SIZE_PX = 160;

export function createEqualFractions(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

export function normalizeFractions(fractions: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (fractions.length !== count) return createEqualFractions(count);

  const safe = fractions.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return createEqualFractions(count);
  return safe.map((value) => value / total);
}

export function buildGridTrackTemplate(fractions: readonly number[]): string {
  return fractions.map((value) => `${(value * 100).toFixed(4)}%`).join(" ");
}

export function resizeTrackFractions(
  fractions: readonly number[],
  index: number,
  deltaPx: number,
  containerPx: number,
  minTrackSizePx: number = MIN_TERMINAL_TRACK_SIZE_PX,
): number[] {
  if (index < 0 || index >= fractions.length - 1) return [...fractions];
  if (containerPx <= 0) return [...fractions];

  const normalized = normalizeFractions(fractions, fractions.length);
  const currentPx = normalized.map((value) => value * containerPx);
  const left = currentPx[index] ?? 0;
  const right = currentPx[index + 1] ?? 0;
  const combined = left + right;
  if (combined <= 0) return normalized;

  const nextLeft = Math.min(
    combined - minTrackSizePx,
    Math.max(minTrackSizePx, left + deltaPx),
  );
  const nextRight = combined - nextLeft;

  const nextPx = [...currentPx];
  nextPx[index] = nextLeft;
  nextPx[index + 1] = nextRight;

  return normalizeFractions(nextPx.map((value) => value / containerPx), normalized.length);
}

export function getTrackHandleOffsets(fractions: readonly number[]): number[] {
  const normalized = normalizeFractions(fractions, fractions.length);
  const offsets: number[] = [];
  let sum = 0;
  for (let index = 0; index < normalized.length - 1; index += 1) {
    sum += normalized[index] ?? 0;
    offsets.push(sum);
  }
  return offsets;
}
