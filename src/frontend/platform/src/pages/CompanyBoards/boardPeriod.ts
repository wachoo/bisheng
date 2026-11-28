export function currentBoardMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
  }).formatToParts(new Date());
  return (
    parts.find((p) => p.type === "year")?.value +
    "-" +
    parts.find((p) => p.type === "month")?.value
  );
}

export function resolveBoardMonth(raw: string | null, today = currentBoardMonth()) {
  return raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && raw >= "2000-01" && raw <= today
    ? raw
    : today;
}
