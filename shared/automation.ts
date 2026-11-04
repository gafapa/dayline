import { taskStatuses, type Resource, type Role } from "./model.js";

export const triggerLabels: Record<string, string> = {
  task_created: "Al crear una tarea",
  task_updated: "Al cambiar una tarea",
  task_overdue: "Cuando una tarea vence",
  daily_summary: "Resumen diario del proyecto",
  recurrence: "Siguiente tarea recurrente",
};
export const actionLabels: Record<string, string> = {
  assign: "Asignar responsable",
  set_status: "Cambiar estado",
  notify: "Crear notificación interna",
};
export const runStatusLabels: Record<string, string> = {
  queued: "Pendiente",
  succeeded: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
};
export { validDay, validTimeZone, zonedClock, nextOccurrence } from "./time.js";
export function ruleMatches(rule: Resource, task: Resource) {
  return (
    task.kind === "task" &&
    !task.deleted_at &&
    !task.data.archived &&
    (!rule.data.projectId || rule.data.projectId === task.data.projectId) &&
    (!rule.data.matchLabel ||
      (task.data.labels || []).includes(rule.data.matchLabel)) &&
    (!rule.data.matchStatus || task.data.status === rule.data.matchStatus)
  );
}
export function canManageRule(rule: Resource, userId: string, role: Role) {
  return role === "admin" || (role === "member" && rule.created_by === userId);
}
export function validAction(action: string, value: string) {
  return action === "set_status"
    ? (taskStatuses as readonly string[]).includes(value)
    : ["assign", "notify"].includes(action) && /^[a-f\d-]{36}$/i.test(value);
}
