import { templateScopeSchema } from "./collections.js";
import { z } from "zod";
import { zonedClock, validDay } from "./time.js";
import type { Resource } from "./model.js";
import { structurePath } from "./hierarchy.js";
export const dashboardWidgets = [
  "summary",
  "portfolio",
  "status",
  "workload",
  "attention",
  "delivery_history",
  "sprint_history",
] as const;
export const widgetLabels: Record<(typeof dashboardWidgets)[number], string> = {
  summary: "Resumen del trabajo",
  portfolio: "Cartera de proyectos",
  status: "Trabajo por estado",
  workload: "Carga del equipo",
  attention: "Necesita atención",
  delivery_history: "Entregas y tiempos",
  sprint_history: "Historial de sprints",
};
export const dashboardConfigSchema = z
  .object({
    projectIds: z.array(z.string().uuid()).max(100).default([]),
    includeDescendants: z.boolean().default(true),
    includeArchived: z.boolean().default(false),
    assigneeIds: z
      .array(z.union([z.string().uuid(), z.literal("unassigned")]))
      .max(100)
      .default([]),
    labels: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    timeZone: z.string().max(100).default("UTC"),
    rangeDays: z
      .union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)])
      .default(30),
    from: z.string().default(""),
    to: z.string().default(""),
    columns: z.union([z.literal(1), z.literal(2)]).default(2),
    widgets: z
      .array(z.enum(dashboardWidgets))
      .min(1)
      .max(7)
      .default([...dashboardWidgets]),
  })
  .strict();
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
export const defaultDashboard = () => dashboardConfigSchema.parse({});
export function reportRange(config: DashboardConfig, now = new Date()) {
  const to = config.to || zonedClock(now, config.timeZone).day,
    from =
      config.from ||
      new Date(
        Date.parse(to + "T12:00:00Z") - (config.rangeDays - 1) * 86400000,
      )
        .toISOString()
        .slice(0, 10);
  if (
    !validDay(from) ||
    !validDay(to) ||
    from > to ||
    Date.parse(to) - Date.parse(from) > 365 * 86400000
  )
    throw new Error(
      "El historial necesita fechas válidas y un intervalo de hasta 366 días.",
    );
  if (Boolean(config.from) !== Boolean(config.to))
    throw new Error("Indica ambas fechas del historial.");
  return { from, to };
}
export function currentAnalytics(
  resources: Resource[],
  config: DashboardConfig,
  now = new Date(),
) {
  const live = resources.filter((r) => !r.deleted_at),
    byId = new Map(resources.map((r) => [r.id, r])),
    today = zonedClock(now, config.timeZone).day;
  const availability = new Map<string, boolean>();
  const available = (resource: Resource, seen = new Set<string>()): boolean => {
    if (resource.deleted_at || seen.has(resource.id) || seen.size > 512)
      return false;
    const cached = availability.get(resource.id);
    if (cached !== undefined) return cached;
    const next = new Set(seen).add(resource.id);
    const result = [
      resource.data.parentId,
      resource.data.targetId,
      resource.kind === "project" ? null : resource.data.projectId,
    ]
      .filter(Boolean)
      .every((id) => {
        const parent = byId.get(id);
        return Boolean(parent && available(parent, next));
      });
    availability.set(resource.id, result);
    return result;
  };
  const projects = live.filter(
    (r) =>
      r.kind === "project" &&
      available(r) &&
      (config.includeArchived ||
        !structurePath(r.id, resources).some((a) => a.data.archived)),
  );
  const selected = new Set(config.projectIds),
    eligibleProjects = new Set(
      projects
        .filter(
          (p) =>
            !selected.size ||
            selected.has(p.id) ||
            (config.includeDescendants &&
              structurePath(p.id, resources).some((a) => selected.has(a.id))),
        )
        .map((p) => p.id),
    );
  const tasks = live.filter(
    (r) =>
      r.kind === "task" &&
      available(r) &&
      (config.includeArchived || !r.data.archived) &&
      (!r.data.projectId
        ? !selected.size
        : eligibleProjects.has(r.data.projectId)) &&
      (!config.assigneeIds.length ||
        config.assigneeIds.includes(r.data.assigneeId || "unassigned")) &&
      config.labels.every((label) => (r.data.labels || []).includes(label)),
  );
  const open = (t: Resource) => !["done", "cancelled"].includes(t.data.status),
    overdue = (t: Resource) =>
      open(t) && validDay(t.data.dueDate || "") && t.data.dueDate < today,
    blocked = (t: Resource) =>
      open(t) &&
      (t.data.dependencies || []).some((id: string) => {
        const dependency = byId.get(id);
        return (
          !dependency ||
          !available(dependency) ||
          dependency.data.status !== "done"
        );
      });
  const points = (items: Resource[]) =>
      items.reduce(
        (n, t) =>
          n + (typeof t.data.estimate === "number" ? t.data.estimate : 0),
        0,
      ),
    working = tasks.filter((t) => t.data.status !== "cancelled"),
    completed = tasks.filter((t) => t.data.status === "done");
  const row = (id: string | null, title: string) => {
    const items = tasks.filter((t) => (t.data.projectId || null) === id);
    return {
      id,
      title,
      total: items.filter((t) => t.data.status !== "cancelled").length,
      done: items.filter((t) => t.data.status === "done").length,
      open: items.filter(open).length,
      points: points(items.filter((t) => t.data.status !== "cancelled")),
      completedPoints: points(items.filter((t) => t.data.status === "done")),
      overdue: items.filter(overdue).length,
      blocked: items.filter(blocked).length,
    };
  };
  return {
    today,
    tasks,
    projects: projects.filter((p) => eligibleProjects.has(p.id)),
    summary: {
      total: working.length,
      done: completed.length,
      open: tasks.filter(open).length,
      points: points(working),
      completedPoints: points(completed),
      overdue: tasks.filter(overdue).length,
      blocked: tasks.filter(blocked).length,
    },
    portfolio: [
      ...projects
        .filter((p) => eligibleProjects.has(p.id))
        .map((p) => row(p.id, p.title)),
      ...(tasks.some((t) => !t.data.projectId)
        ? [row(null, "Sin proyecto")]
        : []),
    ],
    attention: tasks
      .filter((t) => overdue(t) || blocked(t))
      .map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.data.dueDate || "",
        overdue: overdue(t),
        blocked: blocked(t),
      }))
      .sort(
        (a, b) =>
          (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
          a.title.localeCompare(b.title),
      ),
  };
}
export const historyReportSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(false),
    permissionScoped: z.literal(true),
    reason: z.enum(["history_limit", "scope_limit"]),
    range: z.object({ from: z.string(), to: z.string() }),
  }),
  z.object({
    available: z.literal(true),
    permissionScoped: z.literal(true),
    range: z.object({ from: z.string(), to: z.string() }),
    daily: z
      .array(
        z.object({
          day: z.string(),
          completed: z.number().int().nonnegative(),
          reopened: z.number().int().nonnegative(),
        }),
      )
      .max(366),
    completionEvents: z.number().int().nonnegative(),
    deliveredTasks: z.number().int().nonnegative(),
    reopenedEvents: z.number().int().nonnegative(),
    medianLeadHours: z.number().finite().nonnegative().nullable(),
    medianCycleHours: z.number().finite().nonnegative().nullable(),
    leadMeasurements: z.number().int().nonnegative(),
    cycleMeasurements: z.number().int().nonnegative(),
    closedSprints: z
      .array(
        z.object({
          id: z.string().uuid(),
          title: z.string(),
          closedAt: z.string(),
          total: z.number().nonnegative(),
          done: z.number().nonnegative(),
          points: z.number().nonnegative(),
          completedPoints: z.number().nonnegative(),
        }),
      )
      .max(100),
    sprintRowsLimited: z.boolean(),
  }),
]);
export type HistoryReport = z.infer<typeof historyReportSchema>;
export function reportCSV(rows: Array<Array<string | number>>) {
  const cell = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^\s*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}

export function dashboardReferenceScopes(
  config: Pick<DashboardConfig, "projectIds">,
  all: Resource[],
) {
  const scopes = new Map<
    string,
    ReturnType<typeof templateScopeSchema.parse>
  >();
  for (const id of config.projectIds)
    for (const ancestor of structurePath(id, all))
      scopes.set(
        ancestor.id,
        templateScopeSchema.parse({
          id: ancestor.id,
          kind: ancestor.kind,
          createdBy: ancestor.created_by,
          projectId: ancestor.data.projectId || undefined,
          parentId: ancestor.data.parentId || undefined,
          ownerId: ancestor.data.ownerId || undefined,
          private: ancestor.data.private,
          members: ancestor.data.members,
        }),
      );
  if (scopes.size > 500)
    throw new Error(
      "El panel puede conservar el contexto de hasta 500 ubicaciones. Reduce su selección.",
    );
  const result = [...scopes.values()];
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024)
    throw new Error(
      "El contexto de permisos del panel supera 512 KiB. Reduce los proyectos seleccionados.",
    );
  return result;
}
