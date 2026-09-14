/** Shopify liefert Geldbetraege als Strings ("12.90"). */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Kaufmaennisch runden, ohne Gleitkomma-Artefakte wie 1.005 -> 1.00. */
export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  // Das Epsilon faengt Faelle wie 2.675 * 100 = 267.49999999999997 ab.
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

/** Auf Cent runden. */
export const money = (value: number) => round(value, 2);

/** Stueckpreise duerfen feiner aufgeloest sein als Cent. */
export const unitPrice = (value: number) => round(value, 4);
