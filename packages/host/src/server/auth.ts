import { timingSafeEqual } from "node:crypto";

/**
 * Bearer token check for the Standalone Host.
 * All /api/* routes require Authorization: Bearer <apiKey>.
 * Compares in constant time to avoid leaking the token via timing.
 */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const token = Buffer.from(header.slice(7));
  const exp = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; an unequal length is already a
  // non-match, so reject before comparing bytes.
  if (token.length !== exp.length) return false;
  return timingSafeEqual(token, exp);
}
