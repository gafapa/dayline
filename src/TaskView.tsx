import {
  Circle,
  CircleCheck,
  CircleDot,
  Clock3,
  CheckCheck,
} from "lucide-react";
import type { Resource } from "../shared/model";
import { boardColumns, stateLabel } from "../shared/workflow";
import WorkflowStateSelect from "./WorkflowStateSelect";
import { TaskCustomFieldValues } from "./CustomFieldView";
const dateText = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(
        new Date(value),
      )
    : "Sin fecha";
function StatusIcon({ status }: { status: string }) {
  const Icon =
    status === "done"
      ? CircleCheck
      : status === "in_progress"
        ? CircleDot
        : status === "review"
          ? Clock3
          : Circle;
  return <Icon className={`status-icon ${status}`} size={17} />;
}
export default function TaskView({
  tasks,
  projects,
  members,
  mode,
  open,
  update,
  canEdit,
  selected = {},
  toggle,
  fieldColumns = [],
}: any) {
  if (mode === "board")
    return (
      <div className="board">
        {boardColumns(tasks, projects).map((column) => (
          <section
            className="board-column"
            key={column.value}
            aria-label={column.label}
          >
            <h2>
              <StatusIcon status={column.status} />
              {column.label}
              <span>{column.tasks.length}</span>
            </h2>
            {column.tasks
              .map((t: Resource) => (
                <article className="board-task" key={t.id}>
                  <div className="task-choice">
                    {toggle && canEdit && (
                      <label className="task-selection">
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar ${t.title}`}
                          checked={selected[t.id] !== undefined}
                          onChange={() => toggle(t)}
                        />
                      </label>
                    )}
                    <button onClick={() => open(t)}>{t.title}</button>
                  </div>
                  <small>
                    {projects.find((p: Resource) => p.id === t.data.projectId)
                      ?.title || "Sin proyecto"}
                  </small>
                  <TaskCustomFieldValues
                    task={t}
                    projects={projects}
                    members={members}
                    columns={fieldColumns}
                  />
                  <div>
                    {canEdit && (
                      <WorkflowStateSelect
                        label={`Estado de ${t.title}`}
                        task={t}
                        projects={projects}
                        onChange={(data) => void update({ ...t, data })}
                      />
                    )}
                    <span className="avatar small">
                      {members
                        .find((m: any) => m.id === t.data.assigneeId)
                        ?.name?.slice(0, 2)
                        .toUpperCase() || "—"}
                    </span>
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
    );
  if (!tasks.length)
    return (
      <div className="inline-empty">
        <CheckCheck size={20} />
        <span>No hay tareas en esta vista.</span>
      </div>
    );
  return (
    <div className="task-table" role="table" aria-label="Tareas">
      <div className="task-table-head" role="row">
        <span role="columnheader">Tarea</span>
        <span role="columnheader">Estado</span>
        <span role="columnheader">Responsable</span>
        <span role="columnheader">Fecha</span>
      </div>
      {tasks.map((t: Resource) => (
        <div className="task-row" role="row" key={t.id}>
          <div role="cell" className="task-title-cell">
            {toggle && canEdit && (
              <label className="task-selection">
                <input
                  type="checkbox"
                  aria-label={`Seleccionar ${t.title}`}
                  checked={selected[t.id] !== undefined}
                  onChange={() => toggle(t)}
                />
              </label>
            )}
            <button className="task-name" onClick={() => open(t)}>
              <StatusIcon status={t.data.status} />
              <span>
                <strong>{t.title}</strong>
                <small>
                  {projects.find((p: Resource) => p.id === t.data.projectId)
                    ?.title || "Sin proyecto"}
                  {t.data.priority === "urgent" ? " · Urgente" : ""}
                </small>
                <TaskCustomFieldValues
                  task={t}
                  projects={projects}
                  members={members}
                  columns={fieldColumns}
                />
              </span>
            </button>
          </div>
          <div role="cell">
            {canEdit ? (
              <WorkflowStateSelect
                className="inline-select"
                label={`Estado de ${t.title}`}
                task={t}
                projects={projects}
                onChange={(data) => void update({ ...t, data })}
              />
            ) : (
              <span>{stateLabel(t, projects)}</span>
            )}
          </div>
          <span className="assignee-cell" role="cell">
            {t.data.assigneeId ? (
              <>
                <span className="avatar small">
                  {members
                    .find((m: any) => m.id === t.data.assigneeId)
                    ?.name?.slice(0, 2)
                    .toUpperCase() || "—"}
                </span>
                <span>
                  {members.find((m: any) => m.id === t.data.assigneeId)?.name ||
                    "Sin asignar"}
                </span>
              </>
            ) : (
              <span className="muted" aria-label="Sin asignar">
                —
              </span>
            )}
          </span>
          <span className="date-cell" role="cell">
            {dateText(t.data.dueDate)}
          </span>
        </div>
      ))}
    </div>
  );
}
