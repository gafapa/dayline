import {
  CalendarDays,
  ChevronDown,
  Flag,
  ListChecks,
  CheckCheck,
  GripVertical,
  Plus,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { StatusIcon } from "./ui-common";
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
  activeId = null,
  /** Inside a project every card would repeat its name. */
  showProject = true,
}: any) {
  /** Done columns show this week's work; the rest stays behind "Ver las N". */
  const [allDone, setAllDone] = useState<Record<string, boolean>>({});
  const weekAgo = Date.now() - 7 * 86_400_000;
  const recentDone = (column: Column) =>
    column.status !== "done" || allDone[column.value]
      ? column.tasks
      : column.tasks.filter(
          (t: Resource) => Date.parse(t.updated_at) >= weekAgo,
        );
  const today = new Date().toLocaleDateString("en-CA");
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString(
    "en-CA",
  );
  const due = (t: Resource) => {
    if (!t.data.dueDate) return null;
    const open = !["done", "cancelled"].includes(t.data.status);
    const when =
      open && t.data.dueDate < today
        ? "late"
        : open && t.data.dueDate === today
          ? "due-today"
          : "";
    return (
      <span
        className={`board-card-due ${when}`}
        title={`Fecha límite: ${dateText(t.data.dueDate)}${when === "late" ? " (vencida)" : ""}`}
      >
        <CalendarDays size={13} aria-hidden="true" />
        {t.data.dueDate === today
          ? "Hoy"
          : t.data.dueDate === tomorrow
            ? "Mañana"
            : dateText(t.data.dueDate)}
      </span>
    );
  };
  /** Subtasks (child tasks, else checklist items) done out of total. */
  const progress = (t: Resource) => {
    const children = tasks.filter((c: Resource) => c.data.parentId === t.id);
    const total = children.length || (t.data.checklist || []).length;
    const done = children.length
      ? children.filter((c: Resource) => c.data.status === "done").length
      : (t.data.checklist || []).filter((i: any) => i.done).length;
    return total ? { done, total } : null;
  };
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("dayline.listFolded") || "{}");
    } catch {
      return {};
    }
  });
  const fold = (key: string) =>
    setFolded((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        localStorage.setItem("dayline.listFolded", JSON.stringify(next));
      } catch {}
      return next;
    });
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
      (moved.status === task.data.status &&
        moved.stateId === task.data.stateId);
    if (sameColumn && !changes.size) return;
    await update({
      ...task,
      data: changes.has(task.id)
        ? { ...moved, order: changes.get(task.id) }
        : moved,
    });
    for (const other of list)
      if (other.id !== task.id && changes.has(other.id))
        await update({
          ...other,
          data: { ...other.data, order: changes.get(other.id) },
        });
  };
  if (mode === "board")
    return (
      <div
        className={`board ${Object.keys(selected).length ? "selecting" : ""}`}
      >
        {boardColumns(tasks, projects).map((column) => (
          <BoardColumn
            key={column.value}
            column={column}
            canEdit={canEdit}
            place={place}
          >
            {addTask && canEdit && !archivedColumn(column) && (
              <InlineAdd
                label={`Añadir tarea en ${column.label}`}
                add={(title) => addTask(title, column)}
              />
            )}
            {recentDone(column).map((t: Resource) => (
              <BoardCard
                key={t.id}
                task={t}
                column={column}
                canEdit={canEdit}
                place={place}
                active={t.id === activeId}
              >
                {showProject && (
                  <small className="board-card-project">
                    {projects.find((p: Resource) => p.id === t.data.projectId)
                      ?.title || "Sin proyecto"}
                  </small>
                )}
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
                {(t.data.labels || []).length > 0 && (
                  <ul className="board-card-labels" aria-label="Etiquetas">
                    {(t.data.labels as string[]).map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                )}
                <TaskCustomFieldValues
                  task={t}
                  projects={projects}
                  members={members}
                  columns={fieldColumns}
                />
                <div className="board-card-foot">
                  {(t.data.priority === "urgent" ||
                    t.data.priority === "high") && (
                    <span
                      className={`board-card-priority ${t.data.priority}`}
                      title={`Prioridad ${t.data.priority === "urgent" ? "urgente" : "alta"}`}
                    >
                      <Flag size={13} aria-hidden="true" />
                      <span className="board-card-priority-text">
                        {t.data.priority === "urgent" ? "Urgente" : "Alta"}
                      </span>
                    </span>
                  )}
                  {due(t)}
                  {progress(t) && (
                    <span
                      className={`board-card-subtasks ${progress(t)!.done === progress(t)!.total ? "complete" : ""}`}
                      aria-label={`Subtareas: ${progress(t)!.done} de ${progress(t)!.total}`}
                      title="Subtareas hechas"
                    >
                      <ListChecks size={13} aria-hidden="true" />
                      {progress(t)!.done}/{progress(t)!.total}
                    </span>
                  )}
                  <Assignee
                    task={t}
                    members={members}
                    canEdit={canEdit}
                    update={update}
                  />
                </div>
              </BoardCard>
            ))}
            {recentDone(column).length < column.tasks.length && (
              <button
                className="text-button board-more"
                onClick={() => setAllDone({ ...allDone, [column.value]: true })}
              >
                Ver las {column.tasks.length}
              </button>
            )}
          </BoardColumn>
        ))}
      </div>
    );
  const listAdd =
    addTask && canEdit ? (
      <InlineAdd
        label="Añadir tarea"
        add={(title) => addTask(title, { status: "todo", stateId: null })}
      />
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
    <div className="task-table grouped" role="table" aria-label="Tareas">
      <div className="task-table-head" role="row">
        <span role="columnheader">Tarea</span>
        <span role="columnheader">Responsable</span>
        <span role="columnheader">Fecha</span>
      </div>
      {boardColumns(tasks, projects).map((column) => (
        <ListGroup
          key={column.value}
          column={column}
          canEdit={canEdit}
          place={place}
          folded={!!folded[column.value]}
          toggle={() => fold(column.value)}
        >
          {column.tasks.map((t: Resource) => (
            <ListRow
              key={t.id}
              task={t}
              tasks={column.tasks}
              column={column}
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
                <StatusPick
                  task={t}
                  projects={projects}
                  canEdit={canEdit}
                  update={update}
                />
                <button className="task-name" onClick={() => open(t)}>
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
              <span className="assignee-cell" role="cell">
                <Assignee
                  task={t}
                  members={members}
                  canEdit={canEdit}
                  update={update}
                  withName
                />
              </span>
              <span className="date-cell" role="cell">
                {dateText(t.data.dueDate)}
              </span>
            </ListRow>
          ))}
        </ListGroup>
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
      drop: async (item) => {
        if (isTask(item)) await place(item.task, column.tasks, null, column);
      },
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
        {column.limit ? (
          <span
            className={column.tasks.length > column.limit ? "over-limit" : ""}
            title={`Límite: ${column.limit}`}
          >
            {column.tasks.length}/{column.limit}
          </span>
        ) : (
          <span>{column.tasks.length}</span>
        )}
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
  active = false,
  children,
}: {
  task: Resource;
  column: Column;
  canEdit: boolean;
  place: Place;
  active?: boolean;
  children: ReactNode;
}) {
  const drag = useDrag(
    `task:${task.id}`,
    { type: "task", task, label: task.title },
    !canEdit,
  );
  const drop = useDrop(
    `before:${task.id}`,
    {
      accepts: (item) =>
        isTask(item) && item.task.id !== task.id && !archivedColumn(column),
      drop: async (item) => {
        if (isTask(item)) await place(item.task, column.tasks, task.id, column);
      },
    },
    !canEdit,
  );
  return (
    <article
      ref={(node) => {
        drag.ref(node);
        drop.ref(node);
      }}
      aria-current={active ? "true" : undefined}
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

/**
 * The task's assignee as an avatar. Where the task can be edited, clicking it opens the list of
 * people (a native select laid over the avatar, so it works with keyboard, touch and readers).
 */
function Assignee({
  task,
  members,
  canEdit,
  update,
  withName = false,
}: {
  task: Resource;
  members: any[];
  canEdit: boolean;
  update: (task: Resource) => Promise<unknown> | void;
  withName?: boolean;
}) {
  const person = members.find((m: any) => m.id === task.data.assigneeId);
  const face = (
    <>
      <span className={`avatar small ${person ? "" : "avatar-empty"}`}>
        {person?.name?.slice(0, 2).toUpperCase() || "—"}
      </span>
      {withName && (
        <span className={person ? "" : "muted"}>
          {person?.name || "Sin asignar"}
        </span>
      )}
    </>
  );
  if (!canEdit)
    return (
      <span className="assignee-pick" title={person?.name || "Sin asignar"}>
        {face}
      </span>
    );
  return (
    <label
      className="assignee-pick editable"
      title={`Responsable: ${person?.name || "sin asignar"}. Pulsa para cambiarlo`}
    >
      {face}
      <select
        aria-label={`Responsable de ${task.title}`}
        value={task.data.assigneeId || ""}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) =>
          void update({
            ...task,
            data: { ...task.data, assigneeId: e.target.value || null },
          })
        }
      >
        <option value="">Sin asignar</option>
        {members.map((m: any) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A list row with a grip; dropping a task on a row places it just before. */
function ListRow({
  task,
  tasks,
  column,
  canEdit,
  reorderable,
  place,
  children,
}: {
  task: Resource;
  tasks: Resource[];
  column: Column;
  canEdit: boolean;
  reorderable: boolean;
  place: Place;
  children: ReactNode;
}) {
  const drag = useDrag(
    `row:${task.id}`,
    { type: "task", task, label: task.title },
    !canEdit,
  );
  const drop = useDrop(
    `row-before:${task.id}`,
    {
      accepts: (item) =>
        isTask(item) && item.task.id !== task.id && !archivedColumn(column),
      drop: async (item) => {
        if (isTask(item)) await place(item.task, tasks, task.id, column);
      },
    },
    !canEdit,
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
          title={
            reorderable
              ? "Arrastra para reordenar o mover a un proyecto"
              : "Arrastra a un proyecto de la barra lateral"
          }
          {...drag.handle}
        >
          <GripVertical size={15} />
        </button>
      )}
      {children}
    </div>
  );
}

/** A state's group in the list: its header folds it and takes dropped tasks to that state. */
function ListGroup({
  column,
  canEdit,
  place,
  folded,
  toggle,
  children,
}: {
  column: Column;
  canEdit: boolean;
  place: Place;
  folded: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  const drop = useDrop(
    `group:${column.value}`,
    {
      accepts: (item) => isTask(item) && !archivedColumn(column),
      drop: async (item) => {
        if (isTask(item)) await place(item.task, column.tasks, null, column);
      },
    },
    !canEdit,
  );
  return (
    <div
      className={`task-group ${folded ? "folded" : ""}`}
      role="rowgroup"
      aria-label={column.label}
    >
      <div
        ref={drop.ref}
        role="row"
        className={`task-group-head ${drop.over ? "drop-over" : ""} ${drop.armed ? "drop-armed" : ""}`}
      >
        <button
          type="button"
          role="cell"
          aria-expanded={!folded}
          onClick={toggle}
        >
          <ChevronDown
            size={15}
            className="task-group-chevron"
            aria-hidden="true"
          />
          <StatusIcon status={column.status} />
          <span>{column.label}</span>
          <span
            className={
              column.limit && column.tasks.length > column.limit
                ? "over-limit"
                : "task-group-count"
            }
          >
            {column.limit
              ? `${column.tasks.length}/${column.limit}`
              : column.tasks.length}
          </span>
        </button>
      </div>
      {!folded && children}
    </div>
  );
}

/** The row's state icon; where the task can be edited, clicking it opens the list of states. */
function StatusPick({
  task,
  projects,
  canEdit,
  update,
}: {
  task: Resource;
  projects: Resource[];
  canEdit: boolean;
  update: (task: Resource) => Promise<unknown> | void;
}) {
  if (!canEdit)
    return (
      <span className="status-pick" title={stateLabel(task, projects)}>
        <StatusIcon status={task.data.status} />
      </span>
    );
  return (
    <label
      className="status-pick editable"
      title={`${stateLabel(task, projects)}. Pulsa para cambiarlo`}
    >
      <StatusIcon status={task.data.status} />
      <WorkflowStateSelect
        label={`Estado de ${task.title}`}
        task={task}
        projects={projects}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(data) => void update({ ...task, data })}
      />
    </label>
  );
}

/** "+ Añadir tarea" that turns into a title field: Enter creates and stays open, Escape closes. */
function InlineAdd({
  label,
  add,
}: {
  label: string;
  add: (title: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button
        className="inline-add"
        aria-label={label}
        onClick={() => setOpen(true)}
      >
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
