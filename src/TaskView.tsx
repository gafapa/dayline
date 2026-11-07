import {
  Circle,
  CircleCheck,
  CircleDot,
  Clock3,
  CheckCheck,
  GripVertical,
  Plus,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { applyStateOption } from "../shared/workflow";
import { placeInOrder, useDrag, useDrop, type DragItem } from "./dnd";
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
  orderable = false,
  addTask,
}: any) {
  const reorderable = canEdit && orderable;
  /** Saves `task` moved before `beforeId` in `list`, optionally into a new column. */
  const place = async (
    task: Resource,
    list: Resource[],
    beforeId: string | null,
    column?: { status: any; stateId: string | null },
  ) => {
    const changes = reorderable
      ? placeInOrder(list, task, beforeId)
      : new Map<string, number>();
    const moved = column ? applyStateOption(task.data, column) : task.data;
    const sameColumn =
      !column ||
      (moved.status === task.data.status && moved.stateId === task.data.stateId);
    if (sameColumn && !changes.size) return;
    await update({
      ...task,
      data: changes.has(task.id) ? { ...moved, order: changes.get(task.id) } : moved,
    });
    for (const other of list)
      if (other.id !== task.id && changes.has(other.id))
        await update({ ...other, data: { ...other.data, order: changes.get(other.id) } });
  };
  if (mode === "board")
    return (
      <div className="board">
        {boardColumns(tasks, projects).map((column) => (
          <BoardColumn
            key={column.value}
            column={column}
            canEdit={canEdit}
            place={place}
          >
            {addTask && canEdit && !archivedColumn(column) && (
              <InlineAdd label={`Añadir tarea en ${column.label}`} add={(title) => addTask(title, column)} />
            )}
            {column.tasks.map((t: Resource) => (
              <BoardCard
                key={t.id}
                task={t}
                column={column}
                canEdit={canEdit}
                place={place}
              >
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
                <small className="board-card-meta">
                  <span>
                    {projects.find((p: Resource) => p.id === t.data.projectId)?.title || "Sin proyecto"}
                  </span>
                  {t.data.dueDate && (
                    <span className={t.data.dueDate < new Date().toLocaleDateString("en-CA") && !["done", "cancelled"].includes(t.data.status) ? "late" : ""}>
                      {dateText(t.data.dueDate)}
                    </span>
                  )}
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
              </BoardCard>
            ))}
          </BoardColumn>
        ))}
      </div>
    );
  const listAdd =
    addTask && canEdit ? (
      <InlineAdd label="Añadir tarea" add={(title) => addTask(title, { status: "todo", stateId: null })} />
    ) : null;
  if (!tasks.length)
    return (
      <>
        <div className="inline-empty">
          <CheckCheck size={20} />
          <span>No hay tareas en esta vista.</span>
        </div>
        {listAdd}
      </>
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
        <ListRow
          key={t.id}
          task={t}
          tasks={tasks}
          canEdit={canEdit}
          reorderable={reorderable}
          place={place}
        >
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
        </ListRow>
      ))}
      {listAdd}
    </div>
  );
}

type Column = ReturnType<typeof boardColumns>[number];
type Place = (
  task: Resource,
  list: Resource[],
  beforeId: string | null,
  column?: { status: any; stateId: string | null },
) => Promise<void>;
const isTask = (item: DragItem): item is Extract<DragItem, { type: "task" }> =>
  item.type === "task";
const archivedColumn = (column: Column) => column.label.endsWith("(archivado)");

/** A board column: dropping here moves the task to this state, at the end. */
function BoardColumn({
  column,
  canEdit,
  place,
  children,
}: {
  column: Column;
  canEdit: boolean;
  place: Place;
  children: ReactNode;
}) {
  const drop = useDrop(
    `column:${column.value}`,
    {
      accepts: (item) => isTask(item) && !archivedColumn(column),
      drop: async (item) => { if (isTask(item)) await place(item.task, column.tasks, null, column); },
    },
    !canEdit,
  );
  return (
    <section
      ref={drop.ref}
      className={`board-column ${drop.over ? "drop-over" : ""} ${drop.armed ? "drop-armed" : ""}`}
      aria-label={column.label}
    >
      <h2>
        <StatusIcon status={column.status} />
        {column.label}
        <span>{column.tasks.length}</span>
      </h2>
      {children}
    </section>
  );
}

/** A draggable card; dropping another card on it inserts that card just before. */
function BoardCard({
  task,
  column,
  canEdit,
  place,
  children,
}: {
  task: Resource;
  column: Column;
  canEdit: boolean;
  place: Place;
  children: ReactNode;
}) {
  const drag = useDrag(`task:${task.id}`, { type: "task", task, label: task.title }, !canEdit);
  const drop = useDrop(
    `before:${task.id}`,
    {
      accepts: (item) => isTask(item) && item.task.id !== task.id && !archivedColumn(column),
      drop: async (item) => { if (isTask(item)) await place(item.task, column.tasks, task.id, column); },
    },
    !canEdit,
  );
  return (
    <article
      ref={(node) => {
        drag.ref(node);
        drop.ref(node);
      }}
      className={`board-task ${canEdit ? "draggable" : ""} ${drag.dragging ? "dragging" : ""} ${drop.over ? "drop-before" : ""}`}
      {...drag.handle}
      role="group"
      aria-label={task.title}
      aria-roledescription="tarjeta arrastrable"
    >
      {children}
    </article>
  );
}

/** A list row with a grip; dropping a task on a row places it just before. */
function ListRow({
  task,
  tasks,
  canEdit,
  reorderable,
  place,
  children,
}: {
  task: Resource;
  tasks: Resource[];
  canEdit: boolean;
  reorderable: boolean;
  place: Place;
  children: ReactNode;
}) {
  const drag = useDrag(`row:${task.id}`, { type: "task", task, label: task.title }, !canEdit);
  const drop = useDrop(
    `row-before:${task.id}`,
    {
      accepts: (item) => isTask(item) && item.task.id !== task.id,
      drop: async (item) => { if (isTask(item)) await place(item.task, tasks, task.id); },
    },
    !reorderable,
  );
  return (
    <div
      ref={(node) => {
        drag.ref(node);
        drop.ref(node);
      }}
      className={`task-row ${drag.dragging ? "dragging" : ""} ${drop.over ? "drop-before" : ""}`}
      role="row"
    >
      {canEdit && (
        <button
          className="drag-grip"
          aria-label={`Arrastrar ${task.title}`}
          title={reorderable ? "Arrastra para reordenar o mover a un proyecto" : "Arrastra a un proyecto de la barra lateral"}
          {...drag.handle}
        >
          <GripVertical size={15} />
        </button>
      )}
      {children}
    </div>
  );
}

/** "+ Añadir tarea" that turns into a title field: Enter creates and stays open, Escape closes. */
function InlineAdd({ label, add }: { label: string; add: (title: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className="inline-add" aria-label={label} onClick={() => setOpen(true)}>
        <Plus size={15} /> Añadir tarea
      </button>
    );
  return (
    <form
      className="inline-add-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const value = title.trim();
        if (!value || busy) return;
        setBusy(true);
        try {
          await add(value);
          setTitle("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        autoFocus
        aria-label={`Título · ${label}`}
        placeholder="Título y Enter"
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (setOpen(false), setTitle(""))}
        onBlur={() => !title.trim() && setOpen(false)}
      />
    </form>
  );
}
