import { z } from "zod";
import { statusLabels, taskStatuses } from "./task-status.js";
import type { Resource } from "./model.js";

export type TaskStatus = (typeof taskStatuses)[number];
export const workflowStateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    category: z.enum(taskStatuses),
    archived: z.boolean().default(false),
    /** Work-in-progress limit shown on the board; a hint, never enforced. */
    limit: z.number().int().min(1).max(999).optional(),
  })
  .strict();
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export const workflowStatesSchema = z
  .array(workflowStateSchema)
  .max(40)
  .superRefine((states, context) => {
    const ids = new Set<string>(),
      names = new Set<string>();
    for (const state of states) {
      if (ids.has(state.id))
        context.addIssue({ code: "custom", message: "Estado duplicado." });
      ids.add(state.id);
      if (state.archived) continue;
      const name = state.name.toLocaleLowerCase("es");
      if (names.has(name))
        context.addIssue({
          code: "custom",
          message: `El nombre «${state.name}» ya existe en el flujo.`,
        });
      names.add(name);
    }
  });

export const projectStates = (project?: Resource | null): WorkflowState[] => {
  const parsed = workflowStatesSchema.safeParse(
    project?.data.workflowStates || [],
  );
  return parsed.success ? parsed.data : [];
};
const projectOf = (task: Resource, projects: Resource[]) =>
  projects.find((p) => p.kind === "project" && p.id === task.data.projectId);

/** The state a task is displayed in: its own valid state, else its category's first active state. */
export function effectiveState(
  task: Resource,
  projects: Resource[],
): WorkflowState | undefined {
  const states = projectStates(projectOf(task, projects)),
    own = states.find(
      (s) => s.id === task.data.stateId && s.category === task.data.status,
    );
  return (
    own ||
    states.find((s) => !s.archived && s.category === task.data.status)
  );
}
export function stateLabel(task: Resource, projects: Resource[]) {
  return (
    effectiveState(task, projects)?.name ||
    statusLabels[task.data.status] ||
    task.data.status ||
    "Sin estado"
  );
}
export type StateOption = {
  value: string;
  label: string;
  status: TaskStatus;
  stateId: string | null;
  category: TaskStatus;
  limit?: number;
};
/** Ordered choices for a task in its project, keeping its current archived state selectable. */
export function stateOptions(
  project: Resource | undefined | null,
  current?: Resource,
): StateOption[] {
  const states = projectStates(project),
    options: StateOption[] = [];
  for (const category of taskStatuses) {
    const active = states.filter(
      (s) =>
        s.category === category &&
        (!s.archived || s.id === current?.data.stateId),
    );
    if (!active.some((s) => !s.archived))
      options.push({
        value: category,
        label: statusLabels[category],
        status: category,
        stateId: null,
        category,
      });
    for (const state of active)
      options.push({
        value: state.id,
        label: state.archived ? `${state.name} (archivado)` : state.name,
        status: category,
        stateId: state.id,
        category,
        ...(state.limit && !state.archived ? { limit: state.limit } : {}),
      });
  }
  return options;
}
export function optionValue(task: Resource, projects: Resource[]) {
  const state = effectiveState(task, projects);
  return state ? state.id : task.data.status;
}
export function applyStateOption(
  data: Record<string, any>,
  option: Pick<StateOption, "status" | "stateId">,
) {
  const next: Record<string, any> = { ...data, status: option.status };
  if (option.stateId) next.stateId = option.stateId;
  else delete next.stateId;
  return next;
}
/** Board columns: named states for a single-project view, categories otherwise. */
export function boardColumns(tasks: Resource[], projects: Resource[]) {
  const ids = new Set(tasks.map((t) => t.data.projectId || ""));
  const project =
    ids.size === 1 ? projects.find((p) => p.id === [...ids][0]) : undefined;
  const effective = new Map(
    tasks.map((task) => [task.id, project ? effectiveState(task, projects) : undefined]),
  );
  const options: StateOption[] = [];
  for (const option of stateOptions(project)) {
    options.push(option);
    const last = options.filter((o) => o.category === option.category).length;
    const total = stateOptions(project).filter(
      (o) => o.category === option.category,
    ).length;
    if (last !== total) continue;
    // Archived states still holding tasks keep a column after their category's active states.
    for (const state of projectStates(project))
      if (
        state.archived &&
        state.category === option.category &&
        tasks.some((t) => effective.get(t.id)?.id === state.id)
      )
        options.push({
          value: state.id,
          label: `${state.name} (archivado)`,
          status: state.category,
          stateId: state.id,
          category: state.category,
        });
  }
  return options.map((option) => ({
    ...option,
    tasks: tasks.filter((task) =>
      option.stateId
        ? effective.get(task.id)?.id === option.stateId
        : task.data.status === option.status && !effective.get(task.id),
    ),
  }));
}

export class WorkflowStateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
/**
 * Keeps `stateId` consistent with the task's category and project. A stale reference caused by
 * a status or project change is dropped; newly assigning an archived state is refused.
 */
export function normalizeTaskState(
  data: Record<string, any>,
  previous: Record<string, any> | undefined,
  project: Resource | undefined,
) {
  if (data.stateId === undefined || data.stateId === null) {
    const { stateId: _, ...rest } = data;
    return rest;
  }
  const state = projectStates(project).find((s) => s.id === data.stateId);
  if (!state || state.category !== data.status) {
    const { stateId: _, ...rest } = data;
    return rest;
  }
  if (state.archived && previous?.stateId !== state.id)
    throw new WorkflowStateError(
      "Ese estado está archivado. Elige un estado activo del flujo.",
      409,
    );
  return data;
}
/** Project configuration rules: categories are immutable and states are archived, never removed. */
export function checkWorkflowChange(
  next: WorkflowState[],
  previous: WorkflowState[],
) {
  for (const old of previous) {
    const current = next.find((s) => s.id === old.id);
    if (!current)
      throw new WorkflowStateError(
        `Archiva el estado «${old.name}» en lugar de eliminarlo.`,
        409,
      );
    if (current.category !== old.category)
      throw new WorkflowStateError(
        `La categoría del estado «${old.name}» no se puede cambiar.`,
        409,
      );
  }
}
