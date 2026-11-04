import { z } from "zod";
import { validTimeZone } from "./time.js";

export const notificationCategories = [
  "assignment",
  "review",
  "following",
  "comment",
  "mention",
  "automation",
  "reminder",
  "summary",
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export const notificationLabels: Record<NotificationCategory, string> = {
  assignment: "Asignaciones",
  review: "Solicitudes de revisión",
  following: "Elementos que sigues",
  comment: "Comentarios",
  mention: "Menciones",
  automation: "Reglas del equipo",
  reminder: "Avisos de vencimiento",
  summary: "Resúmenes diarios",
};
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const notificationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    categories: z
      .object({
        assignment: z.boolean(),
        review: z.boolean(),
        following: z.boolean(),
        comment: z.boolean(),
        mention: z.boolean(),
        automation: z.boolean(),
        reminder: z.boolean(),
        summary: z.boolean(),
      })
      .strict(),
    quiet: z
      .object({
        enabled: z.boolean(),
        start: clock,
        end: clock,
        timeZone: z
          .string()
          .max(80)
          .refine(validTimeZone, "Zona horaria no válida."),
        days: z
          .array(z.number().int().min(0).max(6))
          .min(1)
          .max(7)
          .refine(
            (days) => new Set(days).size === days.length,
            "Días repetidos.",
          ),
      })
      .strict()
      .refine((value) => !value.enabled || value.start !== value.end, {
        message: "El inicio y el fin deben ser diferentes.",
        path: ["end"],
      }),
  })
  .strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const notificationDraftSchema = notificationSettingsSchema.extend({
  quiet: z
    .object({
      enabled: z.boolean(),
      start: z.string().max(5),
      end: z.string().max(5),
      timeZone: z.string().max(80),
      days: z.array(z.number().int().min(0).max(6)).max(7),
    })
    .strict(),
});
export function defaultNotificationSettings(
  timeZone = "UTC",
): NotificationSettings {
  return {
    enabled: true,
    categories: Object.fromEntries(
      notificationCategories.map((key) => [key, true]),
    ) as NotificationSettings["categories"],
    quiet: {
      enabled: false,
      start: "22:00",
      end: "08:00",
      timeZone: validTimeZone(timeZone) ? timeZone : "UTC",
      days: [0, 1, 2, 3, 4, 5, 6],
    },
  };
}
export function storedNotificationSettings(
  preferences: any,
): NotificationSettings {
  const defaults = defaultNotificationSettings(preferences?.timeZone);
  if (preferences?.notificationSettings === undefined) return defaults;
  const parsed = notificationSettingsSchema.safeParse(
    preferences.notificationSettings,
  );
  return parsed.success ? parsed.data : { ...defaults, enabled: false };
}
export function notificationAllowed(
  settings: NotificationSettings,
  category: NotificationCategory,
) {
  return settings.enabled && settings.categories[category];
}
export function nextNotificationTime(
  settings: NotificationSettings,
  now: Date,
): Date {
  const quiet = settings.quiet;
  if (!quiet.enabled) return now;
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: quiet.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const isQuiet = (time: Date) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(time).map((part) => [part.type, part.value]),
    );
    const day = weekdays.indexOf(parts.weekday),
      clock = `${parts.hour}:${parts.minute}`;
    if (quiet.start < quiet.end)
      return (
        quiet.days.includes(day) && clock >= quiet.start && clock < quiet.end
      );
    return (
      (quiet.days.includes(day) && clock >= quiet.start) ||
      (quiet.days.includes((day + 6) % 7) && clock < quiet.end)
    );
  };
  if (!isQuiet(now)) return now;
  let candidate = new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000);
  // UTC minute steps preserve the first available minute across skipped/repeated local hours.
  for (
    let count = 0;
    count < 2880;
    count++, candidate = new Date(candidate.getTime() + 60000)
  )
    if (!isQuiet(candidate)) return candidate;
  throw new Error("Quiet period exceeded its bounded delivery window");
}
