import { isDeepStrictEqual } from "node:util";
import type { Resource, Role, User } from "../shared/model.js";
import {
  checkWorkflowChange,
  normalizeTaskState,
  workflowStatesSchema,
  WorkflowStateError,
} from "../shared/workflow.js";
import { canManageFields } from "./custom-field-validation.js";
import { HttpError } from "./errors.js";

/** Validates project workflow configuration and normalizes a task's named state. */
export function validateWorkflowData(
  proposed: Resource,
  existing: Resource | undefined,
  all: Resource[],
  user: Pick<User, "id">,
  role: Role,
) {
  const data = { ...proposed.data };
  if (proposed.kind !== "project" && data.workflowStates !== undefined)
    throw new HttpError(400, "El flujo de estados pertenece a un proyecto.");
  if (proposed.kind !== "task" && data.stateId != null)
    throw new HttpError(400, "El estado del flujo pertenece a una tarea.");
  try {
    if (proposed.kind === "project") {
      const parsed = workflowStatesSchema.safeParse(data.workflowStates || []);
      if (!parsed.success)
        throw new HttpError(
          400,
          parsed.error.issues[0]?.message || "El flujo de estados no es válido.",
        );
      const previous = workflowStatesSchema.parse(
        existing?.data.workflowStates || [],
      );
      if (!isDeepStrictEqual(parsed.data, previous)) {
        if (!canManageFields(existing || proposed, user.id, role))
          throw new HttpError(
            403,
            "Solo la administración o la persona que creó el proyecto puede configurar el flujo.",
          );
        checkWorkflowChange(parsed.data, previous);
      }
      if (data.workflowStates !== undefined) data.workflowStates = parsed.data;
      return data;
    }
    if (proposed.kind !== "task") return data;
    const project = all.find(
      (r) => r.kind === "project" && r.id === data.projectId,
    );
    return normalizeTaskState(data, existing?.data, project);
  } catch (error) {
    if (error instanceof WorkflowStateError)
      throw new HttpError(error.status, error.message);
    throw error;
  }
}
