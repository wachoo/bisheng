export function formatMeasure(value?: number | null, decimals = 2) {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: decimals });
}
