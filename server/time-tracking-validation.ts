import { isDeepStrictEqual } from "node:util";
import type { Resource, Role } from "../shared/model.js";
import {
  validateTimeLog,
  retainTimeLogContexts,
} from "../shared/time-tracking.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";

export function validateTimeEntry(
  proposed: Resource,
  previous: Resource | undefined,
  all: Resource[],
  userId: string,
  role: Role,
) {
  if (proposed.kind !== "time_entry") {
    if (
      proposed.data.timeLog !== undefined ||
      proposed.data.timeLogContexts !== undefined
    )
      throw new HttpError(
        400,
        "Estos datos pertenecen a un registro de tiempo.",
      );
    return;
  }
  if (previous && previous.created_by !== userId)
    throw new HttpError(
      403,
      "Solo el autor puede modificar su registro de tiempo.",
    );
  const allowed = new Set([
    "description",
    "projectId",
    "targetId",
    "ownerId",
    "timeLog",
    "timeLogContexts",
    "minutes",
    "archived",
  ]);
  if (Object.keys(proposed.data).some((key) => !allowed.has(key)))
    throw new HttpError(400, "El registro contiene campos que no admite.");
  if (
    previous &&
    ["ownerId", "targetId", "projectId"].some(
      (key) => (previous.data[key] || null) !== (proposed.data[key] || null),
    )
  )
    throw new HttpError(
      400,
      "La visibilidad y las relaciones originales del registro se conservan. Crea otro registro si necesitas cambiar su alcance.",
    );
  if (
    previous &&
    !isDeepStrictEqual(
      proposed.data.timeLogContexts,
      previous.data.timeLogContexts,
    ) &&
    proposed.data.timeLogContexts !== undefined
  )
    throw new HttpError(400, "El contexto de permisos no se puede modificar.");
  if (proposed.deleted_at) return;
  try {
    const log = validateTimeLog(proposed.data.timeLog);
    if (previous?.data.timeLog) {
      const before = previous.data.timeLog;
      if (
        before.mode !== log.mode ||
        before.startedAt !== log.startedAt ||
        before.timeZone !== log.timeZone ||
        (before.status === "recorded" && log.status === "running")
      )
        throw new Error(
          "El origen del registro y el inicio del reloj no se pueden reescribir ni reabrir.",
        );
    }
    const task = proposed.data.targetId
      ? all.find(
          (item) =>
            item.id === proposed.data.targetId &&
            item.kind === "task" &&
            !item.deleted_at,
        )
      : undefined;
    if (proposed.data.targetId && (!task || !canRead(task, userId, role, all)))
      throw new Error("La tarea no está disponible.");
    if (
      task &&
      (task.data.projectId || null) !== (proposed.data.projectId || null) &&
      !previous
    )
      throw new Error("El proyecto del registro debe coincidir con la tarea.");
    for (const id of [proposed.data.projectId, proposed.data.targetId].filter(
      Boolean,
    )) {
      const scope = all.find((item) => item.id === id && !item.deleted_at);
      if (!scope || !canRead(scope, userId, role, all))
        throw new Error("La ubicación no está disponible.");
    }
    proposed.data.timeLog = log;
    proposed.data.minutes = log.seconds / 60;
    proposed.data.timeLogContexts = retainTimeLogContexts(
      proposed,
      all,
      previous?.data.timeLogContexts || [],
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, (error as Error).message);
  }
}
