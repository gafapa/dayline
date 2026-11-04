import {
  fieldFilterSchema,
  fieldReferenceSchema,
  matchesFieldFilter,
} from "./custom-fields.js";
import { z } from "zod";
import type { Resource } from "./model.js";
import { zonedClock } from "./time.js";
export const collectionStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
] as const;
export const taskTypes = [
  "feature",
  "bug",
  "research",
  "maintenance",
  "debt",
  "regression",
] as const;
export const priorities = ["none", "low", "medium", "high", "urgent"] as const;
const id = z.string().uuid(),
  key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const taskViewSchema = z
  .object({
    query: z.string().max(500).default(""),
    fieldFilters: z.array(fieldFilterSchema).max(20).default([]),
    fieldColumns: z.array(fieldReferenceSchema).max(8).default([]),
    projectIds: z.array(id).max(100).default([]),
    sprintIds: z.array(id).max(100).default([]),
    statuses: z.array(z.enum(collectionStatuses)).max(6).default([]),
    assignees: z
      .array(z.union([id, z.enum(["me", "unassigned"])]))
      .max(100)
      .default([]),
    priorities: z.array(z.enum(priorities)).max(5).default([]),
    taskTypes: z.array(z.enum(taskTypes)).max(6).default([]),
    labels: z.array(z.string().max(80)).max(30).default([]),
    due: z.enum(["any", "overdue", "today", "week", "undated"]).default("any"),
    timeZone: z.string().max(100).default("UTC"),
    showArchived: z.boolean().default(false),
    sortBy: z
      .enum(["order", "updated", "due", "priority", "estimate", "title"])
      .default("order"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    groupBy: z.enum(["none", "status", "assignee", "project"]).default("none"),
    layout: z.enum(["list", "board"]).default("list"),
  })
  .strict();
export type TaskViewConfig = z.infer<typeof taskViewSchema>;
export const defaultTaskView = (): TaskViewConfig => taskViewSchema.parse({});
export const templateBlueprintSchema = z
  .object({
    version: z.literal(1),
    rootKey: key,
    nodes: z
      .array(
        z
          .object({
            key,
            kind: z.enum(["project", "folder", "task", "document"]),
            title: z.string().trim().min(1).max(500),
            data: z.record(z.string(), z.unknown()),
            personal: z.boolean().optional(),
            projectKey: key.optional(),
            parentKey: key.optional(),
            dependencies: z.array(key).max(100).default([]),
            related: z.array(key).max(100).default([]),
            startOffset: z.number().int().min(-3650).max(3650).optional(),
            dueOffset: z.number().int().min(-3650).max(3650).optional(),
            endOffset: z.number().int().min(-3650).max(3650).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type TemplateBlueprint = z.infer<typeof templateBlueprintSchema>;
export const templateScopeSchema = z
  .object({
    id,
    kind: z.string().min(1).max(50),
    createdBy: id,
    projectId: id.optional(),
    parentId: id.optional(),
    targetId: id.optional(),
    ownerId: id.optional(),
    assigneeId: id.optional(),
    viewConfig: taskViewSchema.optional(),
    private: z.boolean().optional(),
    members: z.array(id).max(300).optional(),
  })
  .strict();
export type TemplateScope = z.infer<typeof templateScopeSchema>;
export function scopeResource(scope: TemplateScope): Resource {
  return {
    id: scope.id,
    kind: scope.kind as Resource["kind"],
    created_by: scope.createdBy,
    workspace_id: "",
    title: "",
    version: 0,
    created_at: "",
    updated_at: "",
    deleted_at: null,
    data: scope,
  };
}
export function filterTaskView(
  tasks: Resource[],
  config: TaskViewConfig,
  userId: string,
  now = new Date(),
): Resource[] {
  const today = zonedClock(now, config.timeZone).day,
    monday = new Date(today + "T12:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  monday.setUTCDate(monday.getUTCDate() + 6);
  const weekEnd = monday.toISOString().slice(0, 10),
    query = config.query.trim().toLocaleLowerCase();
  const filtered = tasks.filter(
    (task) =>
      task.kind === "task" &&
      !task.deleted_at &&
      config.fieldFilters.every((filter) => matchesFieldFilter(task, filter)) &&
      (config.showArchived || !task.data.archived) &&
      (!config.projectIds.length ||
        config.projectIds.includes(task.data.projectId)) &&
      (!config.sprintIds.length ||
        config.sprintIds.includes(task.data.sprintId)) &&
      (!config.statuses.length || config.statuses.includes(task.data.status)) &&
      (!config.assignees.length ||
        config.assignees.some((id) =>
          id === "me"
            ? task.data.assigneeId === userId
            : id === "unassigned"
              ? !task.data.assigneeId
              : task.data.assigneeId === id,
        )) &&
      (!config.priorities.length ||
        config.priorities.includes(task.data.priority || "none")) &&
      (!config.taskTypes.length ||
        config.taskTypes.includes(task.data.taskType || "feature")) &&
      config.labels.every((label) =>
        (task.data.labels || []).includes(label),
      ) &&
      (!query ||
        `${task.title} ${task.data.description || ""} ${(task.data.labels || []).join(" ")}`
          .toLocaleLowerCase()
          .includes(query)) &&
      (config.due === "any" ||
        (config.due === "undated" && !task.data.dueDate) ||
        (config.due === "today" && task.data.dueDate === today) ||
        (config.due === "week" &&
          task.data.dueDate >= weekStart &&
          task.data.dueDate <= weekEnd) ||
        (config.due === "overdue" &&
          task.data.dueDate &&
          task.data.dueDate < today &&
          !["done", "cancelled"].includes(task.data.status))),
  );
  const value = (task: Resource): string | number | null =>
    config.sortBy === "order"
      ? (task.data.order ?? null)
      : config.sortBy === "updated"
        ? task.updated_at
        : config.sortBy === "due"
          ? task.data.dueDate || null
          : config.sortBy === "priority"
            ? priorities.indexOf(task.data.priority || "none")
            : config.sortBy === "estimate"
              ? (task.data.estimate ?? null)
              : task.title;
  return filtered.sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null) return bv === null ? a.id.localeCompare(b.id) : 1;
    if (bv === null) return -1;
    const order =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), "es", {
            numeric: true,
            sensitivity: "base",
          });
    return (
      (config.direction === "asc" ? order : -order) || a.id.localeCompare(b.id)
    );
  });
}
export function rewriteDocument(
  content: any,
  transform: (node: any) => any,
  depth = 0,
  counter = { value: 0 },
): any {
  if (
    !content ||
    typeof content !== "object" ||
    typeof content.type !== "string" ||
    depth > 50 ||
    ++counter.value > 25000
  )
    throw new Error("Invalid or oversized document structure");
  const result = {
    ...content,
    ...(content.attrs ? { attrs: { ...content.attrs } } : {}),
    ...(content.marks
      ? {
          marks: content.marks.map((mark: any) => ({
            ...mark,
            attrs: { ...mark.attrs },
          })),
        }
      : {}),
  };
  if (content.content) {
    if (!Array.isArray(content.content))
      throw new Error("Invalid document children");
    result.content = content.content.map((child: any) =>
      rewriteDocument(child, transform, depth + 1, counter),
    );
  }
  return transform(result);
}

/* Typed filter: "estado:hecho @lucia vence:semana #api prioridad:alta texto libre". */
const fold = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const statusWords: Record<string, (typeof collectionStatuses)[number]> = {
  backlog: "backlog", pendiente: "backlog", "por-hacer": "todo", porhacer: "todo", todo: "todo",
  "en-curso": "in_progress", encurso: "in_progress", curso: "in_progress", desarrollo: "in_progress",
  revision: "review", "en-revision": "review", hecho: "done", hecha: "done", completada: "done",
  cancelada: "cancelled", cancelado: "cancelled",
};
const dueWords: Record<string, TaskViewConfig["due"]> = {
  hoy: "today", semana: "week", vencidas: "overdue", vencida: "overdue", sin: "undated", "sin-fecha": "undated",
};
const priorityWords: Record<string, (typeof priorities)[number]> = {
  ninguna: "none", baja: "low", media: "medium", alta: "high", urgente: "urgent",
};
export type TypedFilter = Pick<
  TaskViewConfig,
  "query" | "statuses" | "assignees" | "due" | "labels" | "priorities"
>;
/** Turns the one-line filter into view fields; unknown tokens stay as free text. */
export function parseTaskQuery(
  text: string,
  members: { id: string; name: string }[] = [],
): TypedFilter {
  const result: TypedFilter = { query: "", statuses: [], assignees: [], due: "any", labels: [], priorities: [] };
  const free: string[] = [];
  const push = <T,>(list: T[], value: T) => {
    if (!list.includes(value)) list.push(value);
  };
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const word = fold(token);
    const [key, ...rest] = word.split(":");
    const value = rest.join(":");
    if (key === "estado" && statusWords[value]) push(result.statuses, statusWords[value]);
    else if (key === "vence" && dueWords[value]) result.due = dueWords[value];
    else if (key === "prioridad" && priorityWords[value]) push(result.priorities, priorityWords[value]);
    else if (word.startsWith("#") && word.length > 1) push(result.labels, token.slice(1));
    else if (word.startsWith("@") && word.length > 1) {
      const name = word.slice(1);
      const member =
        name === "yo" ? "me" : name === "nadie" ? "unassigned"
        : members.find((m) => fold(m.name).replace(/\s+/g, "").startsWith(name) || fold(m.name).split(/\s+/).includes(name))?.id;
      if (member) push(result.assignees, member);
      else free.push(token);
    } else free.push(token);
  }
  result.query = free.join(" ");
  return result;
}
/** The one-line filter text for a view's fields (inverse of parseTaskQuery). */
export function formatTaskQuery(
  config: TypedFilter,
  members: { id: string; name: string }[] = [],
) {
  const word = (map: Record<string, string>, value: string) =>
    Object.entries(map).find(([, v]) => v === value)?.[0];
  const parts = [
    ...config.statuses.map((s) => `estado:${word(statusWords, s)}`),
    ...config.assignees.map((a) =>
      a === "me" ? "@yo" : a === "unassigned" ? "@nadie"
      : `@${fold(members.find((m) => m.id === a)?.name.split(/\s+/)[0] || a)}`,
    ),
    ...(config.due !== "any" ? [`vence:${word(dueWords, config.due)}`] : []),
    ...config.priorities.map((p) => `prioridad:${word(priorityWords, p)}`),
    ...config.labels.map((l) => `#${l}`),
    config.query,
  ];
  return parts.filter(Boolean).join(" ");
}
