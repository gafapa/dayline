import { z } from "zod";
import { validTimeZone } from "./time.js";

export const reminderSchema = z
  .object({
    at: z
      .string()
      .max(40)
      .refine((value) => {
        const time = Date.parse(value);
        return (
          Number.isFinite(time) &&
          new Date(time).toISOString() === value &&
          time >= Date.UTC(2000, 0, 1) &&
          time < Date.UTC(2100, 0, 1)
        );
      }, "La fecha del recordatorio debe estar entre 2000 y 2099."),
    timeZone: z
      .string()
      .max(80)
      .refine(validTimeZone, "Zona horaria no válida."),
    revisionId: z.string().uuid().toLowerCase(),
    enabled: z.boolean(),
  })
  .strict();
export const reminderTargetKinds = new Set([
  "task",
  "document",
  "project",
  "folder",
  "sprint",
  "milestone",
  "release",
  "decision",
  "risk",
]);
export function reminderLocalTime(at: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function resolveReminderTime(
  local: string,
  timeZone: string,
  occurrence: "earlier" | "later" = "earlier",
) {
  if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d$/.test(local) || !validTimeZone(timeZone))
    throw new Error("Revisa la fecha y la zona horaria.");
  const naive = Date.parse(local + ":00Z");
  if (
    !Number.isFinite(naive) ||
    new Date(naive).toISOString().slice(0, 16) !== local
  )
    throw new Error("La fecha no es válida.");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const matches: string[] = [];
  // Search UTC instants rather than normalizing away nonexistent local times.
  for (let minute = -14 * 60; minute <= 14 * 60; minute++) {
    const candidate = new Date(naive + minute * 60000);
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    if (
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` ===
      local
    )
      matches.push(candidate.toISOString());
  }
  if (!matches.length)
    throw new Error(
      "Esta hora no existe en esa zona por el cambio de horario. Elige otra hora.",
    );
  return {
    at: occurrence === "later" ? matches.at(-1)! : matches[0],
    ambiguous: matches.length > 1,
  };
}

export function reminderOccurrence(
  at: string,
  timeZone: string,
): "earlier" | "later" {
  const local = reminderLocalTime(at, timeZone);
  const minute = Math.floor(Date.parse(at) / 60000) * 60000;
  return Date.parse(resolveReminderTime(local, timeZone).at) === minute
    ? "earlier"
    : "later";
}

export function editedReminderInstant(
  originalAt: string | undefined,
  originalZone: string | undefined,
  local: string,
  timeZone: string,
  occurrence: "earlier" | "later",
) {
  if (
    originalAt &&
    originalZone === timeZone &&
    reminderLocalTime(originalAt, timeZone) === local &&
    reminderOccurrence(originalAt, timeZone) === occurrence
  )
    return originalAt;
  return resolveReminderTime(local, timeZone, occurrence).at;
}
