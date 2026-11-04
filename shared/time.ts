export function validDay(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
export function zonedClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}
export function nextOccurrence(
  due: string,
  recurrence: string,
  after: string,
  anchorDay = Number(due.slice(8)),
) {
  if (!validDay(due) || !validDay(after))
    throw new Error("Invalid recurrence date");
  let cursor = due;
  for (let count = 0; count < 40000; count++) {
    const date = new Date(cursor + "T12:00:00Z");
    if (recurrence === "monthly") {
      const year = date.getUTCFullYear(),
        month = date.getUTCMonth() + 1;
      const last = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(month);
      date.setUTCDate(Math.min(anchorDay, last));
    } else
      date.setUTCDate(date.getUTCDate() + (recurrence === "weekly" ? 7 : 1));
    cursor = date.toISOString().slice(0, 10);
    if (cursor > after) return cursor;
  }
  throw new Error("Recurrence date range exceeded");
}
