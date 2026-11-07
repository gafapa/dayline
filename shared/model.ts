import { z } from "zod";
import { reminderSchema } from "./reminders.js";
import { DOCUMENT_SEED_VERSION } from "./document-protocol.js";
import { workflowStatesSchema } from "./workflow.js";
import { timeLogSchema } from "./time-tracking.js";
import { notificationCategories } from "./notifications.js";
import { dashboardConfigSchema } from "./analytics.js";
import { capacityPlanSchema } from "./sprints.js";
import { deliverySchema, deliveryReceiptSchema } from "./delivery.js";
import {
  customFieldValueSchema,
  fieldDefinitionsSchema,
  fieldSnapshotsSchema,
} from "./custom-fields.js";
import {
  taskViewSchema,
  templateBlueprintSchema,
  templateScopeSchema,
} from "./collections.js";

export const resourceKinds = [
  "project",
  "dashboard",
  "folder",
  "task",
  "document",
  "sprint",
  "team",
  "milestone",
  "release",
  "decision",
  "risk",
  "retrospective",
  "automation",
  "view",
  "time_entry",
  "reminder",
  "template",
  "comment",
  "notification",
] as const;
export const resourceKindSchema = z.enum(resourceKinds);
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type Role = "admin" | "member" | "viewer" | "guest";
export interface User {
  id: string;
  email: string;
  name: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: Role;
}
export interface Resource {
  id: string;
  workspace_id: string;
  kind: ResourceKind;
  title: string;
  data: Record<string, any>;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
import { taskStatuses, statusLabels } from "./task-status.js";
export { taskStatuses, statusLabels };
export const kindLabels: Record<ResourceKind, string> = {
  project: "Proyecto",
  dashboard: "Panel",
  folder: "Carpeta",
  task: "Tarea",
  document: "Documento",
  sprint: "Sprint",
  team: "Equipo",
  milestone: "Hito",
  release: "Versión",
  decision: "Decisión",
  risk: "Riesgo",
  retrospective: "Retrospectiva",
  automation: "Automatización",
  view: "Vista guardada",
  time_entry: "Registro de tiempo",
  reminder: "Recordatorio personal",
  template: "Plantilla",
  comment: "Comentario",
  notification: "Notificación",
};
const id = z.string().uuid();
const text = z.string().max(100000);
const short = z.string().max(500);
const date = z.string().max(40);
const checklist = z
  .array(z.object({ id: z.string().max(80), text: short, done: z.boolean() }))
  .max(300);
export const resourceDataSchema = z
  .object({
    description: text.optional(),
    content: z.any().optional(),
    documentSchemaVersion: z.number().int().positive().optional(),
    documentSeedVersion: z.literal(DOCUMENT_SEED_VERSION).optional(),
    workflowStates: workflowStatesSchema.optional(),
    stateId: id.nullable().optional(),
    personalNote: z.boolean().optional(),
    projectId: id.nullable().optional(),
    parentId: id.nullable().optional(),
    teamId: id.nullable().optional(),
    sprintId: id.nullable().optional(),
    targetId: id.nullable().optional(),
    assigneeId: id.nullable().optional(),
    ownerId: id.optional(),
    status: short.optional(),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
    taskType: z
      .enum(["feature", "bug", "research", "maintenance", "debt", "regression"])
      .optional(),
    labels: z.array(z.string().max(80)).max(30).optional(),
    estimate: z.number().min(0).max(10000).optional(),
    startDate: date.optional(),
    dueDate: date.optional(),
    endDate: date.optional(),
    goal: text.optional(),
    acceptance: text.optional(),
    definitionOfDone: text.optional(),
    checklist: checklist.optional(),
    members: z.array(id).max(300).optional(),
    private: z.boolean().optional(),
    archived: z.boolean().optional(),
    order: z.number().finite().optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    dependencies: z.array(id).max(100).optional(),
    followers: z.array(id).max(300).optional(),
    reviewers: z.array(id).max(100).optional(),
    related: z.array(id).max(100).optional(),
    repository: z.string().url().max(1000).or(z.literal("")).optional(),
    url: z.string().url().max(1000).or(z.literal("")).optional(),
    resolved: z.boolean().optional(),
    read: z.boolean().optional(),
    /** Why a notification was sent (assignment, mention, reminder…). */
    notificationCategory: z.enum(notificationCategories).optional(),
    /** Notification hidden from the inbox until this instant. */
    snoozedUntil: z.string().datetime({ offset: true }).optional(),
    /** Marks the workspace's General project, home of work without another project. */
    general: z.boolean().optional(),
    reminder: reminderSchema.optional(),
    recurrence: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
    recurrenceDay: z.number().int().min(1).max(31).optional(),
    recurrenceEndDate: date.optional(),
    timeZone: z.string().max(100).optional(),
    timeOfDay: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    matchStatus: z.enum(taskStatuses).optional(),
    minutes: z.number().min(0).max(100000).optional(),
    timeLog: timeLogSchema.optional(),
    timeLogContexts: z
      .array(z.array(templateScopeSchema).max(500))
      .max(32)
      .optional(),
    capacity: z.number().min(0).max(100000).optional(),
    capacityPlan: capacityPlanSchema.optional(),
    customFields: z
      .record(z.string().max(80), customFieldValueSchema)
      .optional(),
    fieldDefinitions: fieldDefinitionsSchema.optional(),
    fieldSnapshots: fieldSnapshotsSchema.optional(),
    filters: z.record(z.string(), z.union([short, z.array(short)])).optional(),
    viewConfig: taskViewSchema.optional(),
    dashboardConfig: dashboardConfigSchema.optional(),
    templateBlueprint: templateBlueprintSchema.optional(),
    templateScopes: z.array(templateScopeSchema).max(500).optional(),
    delivery: deliverySchema.optional(),
    deliveryReceipt: deliveryReceiptSchema.optional(),
    action: z.enum(["assign", "set_status", "notify"]).optional(),
    trigger: z
      .enum(["task_created", "task_updated", "task_overdue", "daily_summary"])
      .optional(),
    enabled: z.boolean().optional(),
    actionValue: short.optional(),
    matchLabel: short.optional(),
    snapshot: z.any().optional(),
    closedAt: date.optional(),
    favorites: z.array(id).max(300).optional(),
  })
  .strict();
export const mutationSchema = z.object({
  operationId: id,
  id,
  kind: resourceKindSchema,
  title: z.string().trim().min(1).max(500),
  data: resourceDataSchema,
  expectedVersion: z.number().int().min(0),
  deleted: z.boolean().optional(),
});
export type Mutation = z.infer<typeof mutationSchema>;

export function sprintStats(tasks: Resource[]) {
  const scope = tasks.filter((t) => t.data.status !== "cancelled");
  const done = scope.filter((t) => t.data.status === "done");
  return {
    total: scope.length,
    done: done.length,
    points: scope.reduce((n, t) => n + (t.data.estimate || 0), 0),
    completedPoints: done.reduce((n, t) => n + (t.data.estimate || 0), 0),
    percent: scope.length ? Math.round((done.length / scope.length) * 100) : 0,
  };
}
