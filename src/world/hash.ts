/** Deterministic hash → [0, 1) for slot-based procedural placement. */
export function slotHash(slot: number, salt: number): number {
  let h = (slot * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Two-key variant for (road serial, slot) style keys. */
export function hash2(a: number, b: number, salt: number): number {
  return slotHash(a * 7919 + b * 31 + 17, salt);
}
