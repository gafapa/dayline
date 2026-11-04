import { stateLabel } from "../shared/workflow";
import { useMemo, useState } from "react";
import { useServerCommand } from "./useServerCommand";
import { Field, Modal } from "./components/Primitives";
import TaskView from "./TaskView";
import { CustomFieldViewControls } from "./CustomFieldView";
import { CustomFieldInput } from "./CustomFieldInputs";
import type {
  CustomFieldValue,
  FieldDefinition,
} from "../shared/custom-fields";
import {
  defaultTaskView,
  filterTaskView,
  priorities,
  taskTypes,
  taskViewSchema,
  type TaskViewConfig,
} from "../shared/collections";
import {
  statusLabels,
  taskStatuses,
  type Resource,
  type User,
  type Workspace,
} from "../shared/model";

export default function TaskCollection({
  resources,
  members,
  user,
  workspace,
  projectId,
  myTasks,
  canEdit,
  create,
  save,
  refresh,
  open,
}: {
  resources: Resource[];
  members: { id: string; name: string }[];
  user: User;
  workspace: Workspace;
  projectId: string | null;
  myTasks: boolean;
  canEdit: boolean;
  create: (
    kind: "view",
    title: string,
    data: Record<string, any>,
  ) => Promise<Resource | undefined>;
  save: (resource: Resource) => Promise<Resource | undefined>;
  refresh: () => Promise<void>;
  open: (resource: Resource) => void;
}) {
  const [config, setConfig] = useState<TaskViewConfig>(() => ({
    ...defaultTaskView(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const [viewId, setViewId] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [busy, setBusy] = useState(false),
    [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<Record<string, number>>({}),
    [undo, setUndo] = useState<
      { id: string; expectedVersion: number }[] | null
    >(null);
  const [bulkField, setBulkField] = useState("status"),
    [bulkValue, setBulkValue] = useState("todo");
  const [customBulkValue, setCustomBulkValue] =
    useState<CustomFieldValue>(null);
  const projects = resources.filter(
      (r) => r.kind === "project" && !r.deleted_at && !r.data.archived,
    ),
    sprints = resources.filter((r) => r.kind === "sprint" && !r.deleted_at);
  const views = resources.filter(
      (r) => r.kind === "view" && !r.deleted_at && r.data.viewConfig,
    ),
    current = views.find((r) => r.id === viewId);
  const canManage =
    current && (current.created_by === user.id || workspace.role === "admin");
  const selectedTasks = resources.filter((r) => selected[r.id] !== undefined);
  const commonProject =
    selectedTasks.length &&
    selectedTasks.every(
      (r) => r.data.projectId === selectedTasks[0].data.projectId,
    )
      ? projects.find((p) => p.id === selectedTasks[0].data.projectId)
      : undefined;
  const bulkDefinitions: FieldDefinition[] =
    commonProject?.data.fieldDefinitions?.filter(
      (f: FieldDefinition) => !f.archived,
    ) || [];
  const customBulkDefinition = bulkField.startsWith("custom:")
    ? bulkDefinitions.find((f) => f.id === bulkField.slice(7))
    : undefined;
  const tasks = useMemo(
    () =>
      filterTaskView(
        resources.filter(
          (r) =>
            (!projectId || r.data.projectId === projectId) &&
            (!myTasks || r.data.assigneeId === user.id),
        ),
        config,
        user.id,
      ),
    [resources, projectId, myTasks, config, user.id],
  );
  const patch = (value: Partial<TaskViewConfig>) => {
    setConfig((c) => ({ ...c, ...value }));
    setLimit(100);
  };
  const toggle = (task: Resource) =>
    setSelected((previous) => {
      const next = { ...previous };
      if (next[task.id] !== undefined) delete next[task.id];
      else if (Object.keys(next).length < 100) next[task.id] = task.version;
      return next;
    });
  const count = Object.keys(selected).length;
  const stale = Object.entries(selected).some(
    ([id, version]) => resources.find((r) => r.id === id)?.version !== version,
  );
  const command = useServerCommand(
    user.id,
    workspace.id,
    "task-bulk",
    async (result, request) => {
      setSelected({});
      setUndo(
        request.body.mode === "trash"
          ? result.versions.map((v: any) => ({
              id: v.id,
              expectedVersion: v.version,
            }))
          : null,
      );
      setNotice(`${result.count} tareas confirmadas por el servidor.`);
      await refresh();
    },
  );
  async function bulk(
    mode: "update" | "trash" | "restore",
    restore?: { id: string; expectedVersion: number }[],
  ) {
    setBusy(true);
    setError("");
    try {
      const tasks =
        restore ||
        Object.entries(selected).map(([id, expectedVersion]) => ({
          id,
          expectedVersion,
        }));
      let changes: Record<string, unknown> = {};
      if (mode === "update")
        changes = customBulkDefinition
          ? { customFields: { [customBulkDefinition.id]: customBulkValue } }
          : bulkField === "addLabels" || bulkField === "removeLabels"
            ? {
                [bulkField]: bulkValue
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              }
            : bulkField === "estimate"
              ? { estimate: Number(bulkValue) }
              : bulkField === "archived"
                ? { archived: bulkValue === "true" }
                : {
                    [bulkField]:
                      bulkField === "dueDate" ? bulkValue : bulkValue || null,
                  };
      const result = await command.run(
        `/workspaces/${workspace.id}/tasks/bulk`,
        { tasks, mode, patch: changes },
      );
      setUndo(
        mode === "trash"
          ? result.versions.map((value: { id: string; version: number }) => ({
              id: value.id,
              expectedVersion: value.version,
            }))
          : null,
      );
      setSelected({});
      setNotice(
        `${result.count} tareas ${mode === "trash" ? "enviadas a la papelera" : mode === "restore" ? "restauradas" : "actualizadas"}. Confirmado por el servidor.`,
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const visible = tasks.slice(0, limit),
    groups = new Map<string, Resource[]>();
  for (const task of visible) {
    const key =
      config.groupBy === "status"
        ? stateLabel(task, projects)
        : config.groupBy === "project"
          ? projects.find((p) => p.id === task.data.projectId)?.title ||
            "Sin proyecto"
          : config.groupBy === "assignee"
            ? members.find((m) => m.id === task.data.assigneeId)?.name ||
              "Sin asignar"
            : "";
    groups.set(key, [...(groups.get(key) || []), task]);
  }
  if (!groups.size) groups.set("", []);
  const options = (
    values: readonly string[],
    labels: Record<string, string> = {},
  ) =>
    values.map((v) => (
      <option value={v} key={v}>
        {labels[v] || v}
      </option>
    ));
  return (
    <section className="task-collection" aria-label="Colección de tareas">
      {command.recovery}
      <div className="collection-tools">
        <Field label="Vista guardada">
          <select
            value={viewId}
            onChange={(e) => {
              const id = e.target.value,
                view = views.find((v) => v.id === id);
              setViewId(id);
              if (view) {
                const parsed = taskViewSchema.safeParse(view.data.viewConfig);
                if (parsed.success) {
                  try {
                    new Intl.DateTimeFormat("es", {
                      timeZone: parsed.data.timeZone,
                    });
                    setConfig(parsed.data);
                    setLimit(100);
                  } catch {
                    setError(
                      "La zona horaria de esta vista no está disponible.",
                    );
                  }
                }
              }
            }}
          >
            <option value="">Vista actual</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
                {v.data.ownerId ? " · personal" : " · compartida"}
              </option>
            ))}
          </select>
        </Field>
        {canEdit && (
          <button className="secondary" onClick={() => setSaving(true)}>
            Guardar vista
          </button>
        )}
        {canEdit && canManage && (
          <button
            className="text-button"
            onClick={async () => {
              try {
                await save({
                  ...current!,
                  data: { ...current!.data, viewConfig: config },
                });
                setNotice(
                  "Vista actualizada en este dispositivo; pendiente de sincronización.",
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Actualizar vista
          </button>
        )}
        <div className="view-tabs">
          {(["list", "board"] as const).map((layout) => (
            <button
              key={layout}
              aria-pressed={config.layout === layout}
              className={config.layout === layout ? "active" : ""}
              onClick={() => patch({ layout })}
            >
              {layout === "list" ? "Lista" : "Tablero"}
            </button>
          ))}
        </div>
      </div>
      <div className="collection-filters">
        <Field label="Buscar tareas">
          <input
            type="search"
            value={config.query}
            onChange={(e) => patch({ query: e.target.value })}
            placeholder="Título, descripción o etiqueta"
          />
        </Field>
        <Field label="Filtrar por estado">
          <select
            value={config.statuses[0] || ""}
            onChange={(e) =>
              patch({ statuses: e.target.value ? [e.target.value as any] : [] })
            }
          >
            <option value="">Todos los estados</option>
            {options(taskStatuses, statusLabels)}
          </select>
        </Field>
        <Field label="Filtrar por responsable">
          <select
            value={config.assignees[0] || ""}
            onChange={(e) =>
              patch({ assignees: e.target.value ? [e.target.value] : [] })
            }
          >
            <option value="">Todos los responsables</option>
            <option value="me">Yo, para quien abra la vista</option>
            <option value="unassigned">Sin asignar</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <details className="collection-advanced">
        <summary>Más filtros y ordenación</summary>
        <div className="collection-filters">
          <Field label="Proyecto de la vista">
            <select
              value={config.projectIds[0] || ""}
              onChange={(e) =>
                patch({ projectIds: e.target.value ? [e.target.value] : [] })
              }
            >
              <option value="">Todos los proyectos</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sprint de la vista">
            <select
              value={config.sprintIds[0] || ""}
              onChange={(e) =>
                patch({ sprintIds: e.target.value ? [e.target.value] : [] })
              }
            >
              <option value="">Todos los sprints</option>
              {sprints.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prioridad de la vista">
            <select
              value={config.priorities[0] || ""}
              onChange={(e) =>
                patch({
                  priorities: e.target.value ? [e.target.value as any] : [],
                })
              }
            >
              <option value="">Todas las prioridades</option>
              {options(priorities, {
                none: "Sin prioridad",
                low: "Baja",
                medium: "Media",
                high: "Alta",
                urgent: "Urgente",
              })}
            </select>
          </Field>
          <Field label="Tipo de tarea">
            <select
              value={config.taskTypes[0] || ""}
              onChange={(e) =>
                patch({
                  taskTypes: e.target.value ? [e.target.value as any] : [],
                })
              }
            >
              <option value="">Todos los tipos</option>
              {options(taskTypes, {
                feature: "Funcionalidad",
                bug: "Error",
                research: "Investigación",
                maintenance: "Mantenimiento",
                debt: "Deuda técnica",
                regression: "Regresión",
              })}
            </select>
          </Field>
          <Field label="Todas estas etiquetas">
            <input
              value={config.labels.join(", ")}
              onChange={(e) =>
                patch({
                  labels: e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
              placeholder="Separadas por comas"
            />
          </Field>
          <Field label="Vencimiento">
            <select
              value={config.due}
              onChange={(e) => patch({ due: e.target.value as any })}
            >
              {options(["any", "overdue", "today", "week", "undated"], {
                any: "Cualquier fecha",
                overdue: "Vencidas",
                today: "Hoy",
                week: "Esta semana",
                undated: "Sin fecha",
              })}
            </select>
          </Field>
          <Field label="Ordenar por">
            <select
              value={config.sortBy}
              onChange={(e) => patch({ sortBy: e.target.value as any })}
            >
              {options(
                ["order", "updated", "due", "priority", "estimate", "title"],
                {
                  order: "Orden de planificación",
                  updated: "Última actualización",
                  due: "Fecha límite",
                  priority: "Prioridad",
                  estimate: "Estimación",
                  title: "Título",
                },
              )}
            </select>
          </Field>
          <Field label="Dirección">
            <select
              value={config.direction}
              onChange={(e) => patch({ direction: e.target.value as any })}
            >
              <option value="asc">Ascendente</option>
              <option value="desc">Descendente</option>
            </select>
          </Field>
          <Field label="Agrupar por">
            <select
              value={config.groupBy}
              onChange={(e) => patch({ groupBy: e.target.value as any })}
            >
              {options(["none", "status", "assignee", "project"], {
                none: "Sin agrupar",
                status: "Estado",
                assignee: "Responsable",
                project: "Proyecto",
              })}
            </select>
          </Field>
          <Field label="Zona horaria">
            <input
              key={config.timeZone}
              defaultValue={config.timeZone}
              onBlur={(e) => {
                const zone = e.target.value;
                try {
                  new Intl.DateTimeFormat("es", { timeZone: zone });
                  patch({ timeZone: zone });
                  setError("");
                } catch {
                  setError(
                    "Usa una zona horaria válida, por ejemplo Europe/Madrid.",
                  );
                }
              }}
            />
          </Field>
          <label className="check-field">
            <input
              type="checkbox"
              checked={config.showArchived}
              onChange={(e) => patch({ showArchived: e.target.checked })}
            />
            Incluir archivadas
          </label>
          <button
            className="text-button"
            onClick={() => {
              setViewId("");
              setConfig(defaultTaskView());
              setLimit(100);
            }}
          >
            Limpiar filtros
          </button>
        </div>
      </details>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status">
          {notice}{" "}
          {undo && (
            <button
              className="text-button"
              disabled={busy || !navigator.onLine}
              onClick={() => void bulk("restore", undo)}
            >
              Deshacer envío a papelera
            </button>
          )}
        </p>
      )}
      <div className="collection-summary">
        <p className="collection-count">
          {tasks.length} tareas · {config.timeZone}
        </p>
        {canEdit && (
          <>
            <button
              className="text-button"
              disabled={!visible.length}
              onClick={() =>
                setSelected(
                  Object.fromEntries(
                    visible.slice(0, 100).map((t) => [t.id, t.version]),
                  ),
                )
              }
            >
              Seleccionar hasta 100 visibles
            </button>
            {count > 0 && (
              <button className="text-button" onClick={() => setSelected({})}>
                Limpiar selección
              </button>
            )}
          </>
        )}
      </div>
      <CustomFieldViewControls
        projects={projects}
        members={members}
        filters={config.fieldFilters}
        columns={config.fieldColumns}
        change={(fieldFilters, fieldColumns) =>
          patch({ fieldFilters, fieldColumns })
        }
      />
      {count > 0 && (
        <div className="bulk-controls" aria-label="Edición por lotes">
          <strong>{count} seleccionadas</strong>
          {stale && (
            <p role="alert">
              La selección contiene cambios posteriores. Revisa las tareas y
              vuelve a seleccionarlas.
            </p>
          )}
          <Field label="Campo del lote">
            <select
              value={bulkField}
              onChange={(e) => {
                setBulkField(e.target.value);
                setCustomBulkValue(null);
                setBulkValue(
                  e.target.value === "status"
                    ? "todo"
                    : e.target.value === "archived"
                      ? "true"
                      : "",
                );
              }}
            >
              {options(
                [
                  "status",
                  "priority",
                  "taskType",
                  "assigneeId",
                  "projectId",
                  "sprintId",
                  "dueDate",
                  "estimate",
                  "addLabels",
                  "removeLabels",
                  "archived",
                ],
                {
                  status: "Estado",
                  priority: "Prioridad",
                  taskType: "Tipo",
                  assigneeId: "Responsable",
                  projectId: "Proyecto",
                  sprintId: "Sprint",
                  dueDate: "Fecha límite",
                  estimate: "Estimación",
                  addLabels: "Añadir etiquetas",
                  removeLabels: "Quitar etiquetas",
                  archived: "Archivo",
                },
              )}
              {bulkDefinitions.map((field) => (
                <option key={field.id} value={`custom:${field.id}`}>
                  {field.name} · Campo del proyecto
                </option>
              ))}
            </select>
          </Field>
          {customBulkDefinition ? (
            <CustomFieldInput
              field={customBulkDefinition}
              label="Valor del lote"
              value={customBulkValue}
              change={setCustomBulkValue}
              members={members}
              editable={canEdit}
            />
          ) : (
            <Field label="Valor del lote">
              {[
                "status",
                "priority",
                "taskType",
                "assigneeId",
                "projectId",
                "sprintId",
                "archived",
              ].includes(bulkField) ? (
                <select
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                >
                  <option
                    value=""
                    disabled={[
                      "status",
                      "priority",
                      "taskType",
                      "archived",
                    ].includes(bulkField)}
                  >
                    Sin asignar
                  </option>
                  {bulkField === "status" ? (
                    options(taskStatuses, statusLabels)
                  ) : bulkField === "priority" ? (
                    options(priorities)
                  ) : bulkField === "taskType" ? (
                    options(taskTypes)
                  ) : bulkField === "archived" ? (
                    <>
                      <option value="true">Archivar</option>
                      <option value="false">Desarchivar</option>
                    </>
                  ) : (
                    (bulkField === "assigneeId"
                      ? members
                      : bulkField === "projectId"
                        ? projects
                        : sprints
                    ).map((r: any) => (
                      <option key={r.id} value={r.id}>
                        {r.name || r.title}
                      </option>
                    ))
                  )}
                </select>
              ) : (
                <input
                  type={
                    bulkField === "dueDate"
                      ? "date"
                      : bulkField === "estimate"
                        ? "number"
                        : "text"
                  }
                  min="0"
                  max="10000"
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                />
              )}
            </Field>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              stale ||
              !canEdit ||
              !navigator.onLine ||
              (bulkField.startsWith("custom:") && !customBulkDefinition)
            }
            onClick={() => void bulk("update")}
          >
            Aplicar a la selección
          </button>
          <button
            className="secondary"
            disabled={
              busy ||
              stale ||
              !canEdit ||
              !navigator.onLine ||
              (bulkField.startsWith("custom:") && !customBulkDefinition)
            }
            onClick={() => void bulk("trash")}
          >
            Enviar selección a papelera
          </button>
          <p className="muted">
            Se guardan todas juntas o ninguna. Requiere conexión.
          </p>
        </div>
      )}
      {[...groups].map(([label, items]) => (
        <section key={label}>
          {label && (
            <h2 className="collection-group">
              {label}{" "}
              <small>
                {tasks.filter((t) => items.some((i) => i.id === t.id)).length}
              </small>
            </h2>
          )}
          <TaskView
            tasks={items}
            projects={projects}
            members={members}
            mode={config.layout}
            open={open}
            update={save}
            canEdit={canEdit}
            selected={selected}
            toggle={toggle}
            fieldColumns={config.fieldColumns}
          />
        </section>
      ))}
      {tasks.length > limit && (
        <button className="secondary" onClick={() => setLimit((n) => n + 100)}>
          Mostrar 100 más ({visible.length} de {tasks.length})
        </button>
      )}
      {saving && (
        <Modal title="Guardar vista" close={() => setSaving(false)}>
          <form
            className="modal-body"
            onSubmit={async (e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              try {
                const result = await create("view", String(data.get("title")), {
                  viewConfig: config,
                  ...(data.get("shared") ? {} : { ownerId: user.id }),
                });
                setViewId(result?.id || "");
                setSaving(false);
                setNotice(
                  "Vista guardada en este dispositivo; pendiente de sincronización.",
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Field label="Nombre de la vista">
              <input name="title" required maxLength={500} />
            </Field>
            <label className="check-field">
              <input name="shared" type="checkbox" />
              Compartir con quienes tengan acceso a sus proyectos y sprints
            </label>
            <p className="muted">
              Los filtros «Yo» y las fechas relativas se calculan para quien
              abra la vista. La sección y el proyecto actuales siguen limitando
              los resultados.
            </p>
            <button className="primary">Guardar vista</button>
          </form>
        </Modal>
      )}
    </section>
  );
}
