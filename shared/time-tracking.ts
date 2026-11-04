import { z } from "zod";
import type { Resource } from "./model.js";
import { templateScopeSchema, type TemplateScope } from "./collections.js";
import { validDay, validTimeZone, zonedClock } from "./time.js";

export const MAX_LOG_SECONDS = 7 * 24 * 60 * 60;
const zoneCache = new Map<string, boolean>();
function validLogZone(value: string) {
  const known = zoneCache.get(value);
  if (known !== undefined) return known;
  const valid = validTimeZone(value);
  if (zoneCache.size >= 128) zoneCache.delete(zoneCache.keys().next().value!);
  zoneCache.set(value, valid);
  return valid;
}
export const timeLogSchema = z
  .object({
    date: z.string().refine(validDay, "La fecha no es válida."),
    timeZone: z
      .string()
      .max(100)
      .refine(validLogZone, "La zona horaria no es válida."),
    mode: z.enum(["manual", "timer"]),
    status: z.enum(["recorded", "running"]),
    seconds: z.number().int().min(0).max(MAX_LOG_SECONDS),
    startedAt: z.string().datetime({ offset: true }).optional(),
    stoppedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type TimeLog = z.infer<typeof timeLogSchema>;
export function validateTimeLog(value: unknown, now = new Date()): TimeLog {
  const parsed = timeLogSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues[0]?.message || "El registro de tiempo no es válido.",
    );
  const log = parsed.data;
  if (log.mode === "manual") {
    if (
      log.status !== "recorded" ||
      log.seconds < 1 ||
      log.startedAt ||
      log.stoppedAt
    )
      throw new Error(
        "El registro manual necesita una duración positiva y no utiliza intervalos de reloj.",
      );
  } else {
    const start = Date.parse(log.startedAt || ""),
      end = Date.parse(log.stoppedAt || "");
    if (!Number.isFinite(start) || start > now.getTime() + 5 * 60 * 1000)
      throw new Error(
        "El inicio del temporizador no es válido o está en el futuro.",
      );
    if (log.status === "running") {
      if (log.seconds || log.stoppedAt)
        throw new Error(
          "Un temporizador activo todavía no tiene duración registrada.",
        );
    } else {
      const seconds = Math.floor((end - start) / 1000);
      if (
        !Number.isFinite(end) ||
        end > now.getTime() + 5 * 60 * 1000 ||
        seconds < 1 ||
        seconds > MAX_LOG_SECONDS
      )
        throw new Error(
          "El intervalo debe durar entre un segundo y siete días. Si el reloj quedó abierto, registra una duración manual corregida y elimina el temporizador.",
        );
      if (log.seconds !== seconds)
        throw new Error(
          "La duración no coincide con el intervalo del temporizador.",
        );
    }
  }
  return log;
}
export function todayForLog(timeZone: string, now = new Date()) {
  return zonedClock(now, timeZone).day;
}
export function elapsedLogSeconds(log: TimeLog, now = new Date()) {
  return log.status === "recorded"
    ? log.seconds
    : Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(log.startedAt || "")) / 1000),
      );
}
export function formatLogDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600)}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
// A time log retains its original task and ancestor permission context.
export function timeLogReferenceScopes(
  resource: Resource,
  all: Resource[],
): TemplateScope[] {
  const byId = new Map(all.map((item) => [item.id, item])),
    scopes = new Map<string, TemplateScope>(),
    visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw new Error("La ubicación del registro contiene un ciclo.");
    if (scopes.has(id)) return;
    if (scopes.size >= 500)
      throw new Error("El registro supera 500 ubicaciones de contexto.");
    const item = byId.get(id);
    if (!item || item.deleted_at)
      throw new Error("La ubicación del registro no está disponible.");
    if (
      ![
        "project",
        "folder",
        "document",
        "task",
        "sprint",
        "team",
        "comment",
        "notification",
        "retrospective",
        "automation",
      ].includes(item.kind)
    )
      throw new Error(
        "La jerarquía contiene permisos que este registro no puede conservar. Crea una entrada vinculada solo al proyecto o sin tarea.",
      );
    visiting.add(id);
    const data = item.data;
    scopes.set(
      id,
      templateScopeSchema.parse({
        id,
        kind: item.kind,
        createdBy: item.created_by,
        projectId: data.projectId || undefined,
        parentId: data.parentId || undefined,
        targetId: data.targetId || undefined,
        ownerId: data.ownerId || undefined,
        assigneeId:
          item.kind === "notification"
            ? data.assigneeId || undefined
            : undefined,
        private: item.kind === "project" ? data.private : undefined,
        members:
          item.kind === "project" && Array.isArray(data.members)
            ? [...data.members].sort()
            : undefined,
      }),
    );
    for (const parent of [data.projectId, data.parentId, data.targetId])
      if (parent) visit(parent);
    visiting.delete(id);
  }
  for (const id of [resource.data.projectId, resource.data.targetId])
    if (id) visit(id);
  const result = [...scopes.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024)
    throw new Error("El contexto de permisos supera 512 KiB.");
  return result;
}
export function retainTimeLogContexts(
  resource: Resource,
  all: Resource[],
  previous: TemplateScope[][] = [],
) {
  // PostgreSQL jsonb does not preserve object-key insertion order.
  const key = (context: TemplateScope[]) =>
    JSON.stringify(
      context
        .map((scope) => templateScopeSchema.parse(scope))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  const current = timeLogReferenceScopes(resource, all),
    serialized = key(current);
  const contexts = previous.some((context) => key(context) === serialized)
    ? previous
    : [...previous, current];
  if (
    contexts.length > 32 ||
    new TextEncoder().encode(JSON.stringify(contexts)).byteLength > 512 * 1024
  )
    throw new Error(
      "El registro supera el límite de contexto de permisos. Conserva esta entrada y crea otra para el trabajo nuevo.",
    );
  return contexts;
}
export type TimeLogFilter = {
  from: string;
  to: string;
  projectId: string;
  authorId: string;
  includeDescendants: boolean;
  includeArchived: boolean;
};
export function filterTimeEntries(
  resources: Resource[],
  filter: TimeLogFilter,
): Resource[] {
  if (!validDay(filter.from) || !validDay(filter.to) || filter.from > filter.to)
    throw new Error("Selecciona un periodo válido para los registros.");
  const byId = new Map(resources.map((item) => [item.id, item]));
  function available(id: string, seen = new Set<string>()): boolean {
    if (seen.has(id) || seen.size >= 512) return false;
    seen.add(id);
    const item = byId.get(id);
    if (
      !item ||
      item.deleted_at ||
      (!filter.includeArchived && item.data.archived)
    )
      return false;
    return [item.data.parentId, item.data.projectId, item.data.targetId]
      .filter(Boolean)
      .every((parent) => available(parent, new Set(seen)));
  }
  function matchesProject(entry: Resource) {
    let id = entry.data.projectId,
      visited = new Set<string>();
    while (id && !visited.has(id) && visited.size < 512) {
      if (id === filter.projectId) return true;
      if (!filter.includeDescendants) break;
      visited.add(id);
      const parent = byId.get(id);
      id = parent?.data.parentId || parent?.data.projectId;
    }
    return false;
  }
  return resources
    .filter((entry) => {
      if (entry.kind !== "time_entry" || !available(entry.id)) return false;
      const parsed = timeLogSchema.safeParse(entry.data.timeLog);
      if (!parsed.success) return false;
      const log = parsed.data;
      return (
        log.date >= filter.from &&
        log.date <= filter.to &&
        (!filter.projectId || matchesProject(entry)) &&
        (!filter.authorId || entry.created_by === filter.authorId) &&
        (entry.data.timeLogContexts || [])
          .flat()
          .every((scope: TemplateScope) => available(scope.id))
      );
    })
    .sort(
      (a, b) =>
        b.data.timeLog.date.localeCompare(a.data.timeLog.date) ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id),
    );
}
export function timeEntrySummary(entries: Resource[]) {
  const projects = new Map<string, number>(),
    authors = new Map<string, number>(),
    days = new Map<string, number>();
  let seconds = 0,
    recorded = 0,
    running = 0;
  for (const entry of entries) {
    const log = timeLogSchema.parse(entry.data.timeLog);
    if (log.status === "running") {
      running++;
      continue;
    }
    seconds += log.seconds;
    recorded++;
    for (const [map, key] of [
      [projects, entry.data.projectId || ""],
      [authors, entry.created_by],
      [days, log.date],
    ] as const)
      map.set(key, (map.get(key) || 0) + log.seconds);
  }
  return {
    seconds,
    recorded,
    running,
    projects: [...projects],
    authors: [...authors],
    days: [...days].sort((a, b) => a[0].localeCompare(b[0])),
  };
}
