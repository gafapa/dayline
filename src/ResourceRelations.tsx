import { useState } from "react";
import { Plus, ArrowRight, Trash2, X } from "lucide-react";
import { StatusIcon } from "./ui-common";
import type { Resource } from "../shared/model";
import { documentReferences } from "../shared/documents";
import { Field } from "./components/Primitives";
import { ConfiguredTaskFields } from "./CustomFieldInputs";
import {
  fieldDefaults,
  type CustomFieldValue,
  fieldValueLabel,
  type FieldDefinition,
  type FieldSnapshot,
} from "../shared/custom-fields";

export function ResourceRelations({
  draft,
  resources,
  members,
  editable,
  setData,
  open,
  create,
}: {
  draft: Resource;
  resources: Resource[];
  members: any[];
  editable: boolean;
  setData: (patch: any) => void;
  open: (resource: Resource) => void;
  create: (kind: any, title: string, data: any) => Promise<any>;
}) {
  const [fieldName, setFieldName] = useState(""),
    [fieldType, setFieldType] = useState("text");
  const candidates = resources.filter(
      (r) => r.id !== draft.id && r.kind === draft.kind && !r.data.personalNote,
    ),
    tasks = resources.filter((r) => r.kind === "task" && r.id !== draft.id);
  const blockers = tasks.filter(
    (t) =>
      (draft.data.dependencies || []).includes(t.id) &&
      !["done", "cancelled"].includes(t.data.status),
  );
  const [childFields, setChildFields] = useState<
      Record<string, CustomFieldValue>
    >({}),
    [childError, setChildError] = useState("");
  const children = resources.filter((r) => r.data.parentId === draft.id);
  const definitions: FieldDefinition[] =
    draft.kind === "task"
      ? resources.find(
          (r) => r.id === draft.data.projectId && r.kind === "project",
        )?.data.fieldDefinitions || []
      : [];
  const snapshots: FieldSnapshot[] =
    draft.kind === "task" ? draft.data.fieldSnapshots || [] : [];
  const managed = new Set([
    ...definitions.map((f) => f.id),
    ...snapshots.map((f) => f.id),
  ]);
  const planned = !!(
    draft.data.parentId ||
    (draft.data.taskType && draft.data.taskType !== "feature") ||
    draft.data.startDate ||
    (draft.data.recurrence && draft.data.recurrence !== "none") ||
    draft.data.dependencies?.length ||
    draft.data.reviewers?.length
  );
  const backlinks = resources.filter(
    (r) =>
      r.id !== draft.id &&
      r.kind === "document" &&
      documentReferences(r.data.content).includes(draft.id),
  );
  const parentField = (
    <Field
      label={
        draft.kind === "task"
          ? "Tarea principal"
          : draft.kind === "document"
            ? "Página superior"
            : "Proyecto superior"
      }
    >
      <select
        value={draft.data.parentId || ""}
        disabled={!editable}
        onChange={(e) => setData({ parentId: e.target.value || null })}
      >
        <option value="">Sin elemento superior</option>
        {candidates.map((r) => (
          <option value={r.id} key={r.id}>
            {r.title}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <section className="task-extra-fields">
      {(children.length > 0 || (draft.kind === "task" && editable)) && (
        <section className="relation-children">
          <h3>{draft.kind === "task" ? "Subtareas" : "Elementos anidados"}</h3>
          <div className="relation-list">
            {children.map((r) => (
              <button
                className="linked-row relation-row"
                onClick={() => open(r)}
                key={r.id}
              >
                {r.kind === "task" && <StatusIcon status={r.data.status} />}
                <span
                  className={r.data.status === "done" ? "relation-done" : ""}
                >
                  {r.title}
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        </section>
      )}
      {editable &&
        !draft.data.personalNote &&
        ["task", "document", "project"].includes(draft.kind) && (
          <form
            className={
              draft.kind === "task" && definitions.length
                ? "nested-field-form"
                : "inline-form"
            }
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const title = String(
                new FormData(form).get("title") || "",
              ).trim();
              if (!title) return;
              setChildError("");
              try {
                await create(draft.kind, title, {
                  parentId: draft.id,
                  ...(draft.data.projectId
                    ? { projectId: draft.data.projectId }
                    : {}),
                  ...(draft.kind === "task"
                    ? {
                        status: "backlog",
                        priority: "medium",
                        customFields: {
                          ...fieldDefaults(definitions),
                          ...childFields,
                        },
                      }
                    : {}),
                });
                form.reset();
                setChildFields({});
              } catch (error) {
                setChildError((error as Error).message);
              }
            }}
          >
            <input
              name="title"
              required
              maxLength={500}
              aria-label="Título del elemento anidado"
              placeholder={
                draft.kind === "task"
                  ? "Añadir subtarea…"
                  : "Añadir elemento anidado…"
              }
            />
            {childError && <p role="alert">{childError}</p>}
            {draft.kind === "task" && (
              <ConfiguredTaskFields
                definitions={definitions}
                values={{ ...fieldDefaults(definitions), ...childFields }}
                sectionLabel="Campos de la nueva subtarea"
                change={setChildFields}
                editable={editable}
                members={members}
                required
              />
            )}
            <button aria-label="Crear elemento anidado">
              <Plus size={16} />
            </button>
          </form>
        )}
      {draft.kind === "task" ? (
        <details
          className="more-fields relation-details"
          open={planned || undefined}
        >
          <summary>Planificación y relaciones</summary>
          <div className="form-grid">
            {parentField}
            <Field label="Tipo de tarea">
              <select
                value={draft.data.taskType || "feature"}
                disabled={!editable}
                onChange={(e) => setData({ taskType: e.target.value })}
              >
                {[
                  ["feature", "Funcionalidad"],
                  ["bug", "Error"],
                  ["research", "Investigación"],
                  ["maintenance", "Mantenimiento"],
                  ["debt", "Deuda técnica"],
                  ["regression", "Regresión"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Inicio previsto">
              <input
                type="date"
                value={draft.data.startDate || ""}
                readOnly={!editable}
                onChange={(e) => setData({ startDate: e.target.value })}
              />
            </Field>
            <Field label="Al completar, repetir">
              <select
                value={draft.data.recurrence || "none"}
                disabled={!editable}
                onChange={(e) =>
                  setData({
                    recurrence: e.target.value,
                    timeZone:
                      draft.data.timeZone ||
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                  })
                }
              >
                <option value="none">No repetir</option>
                <option value="daily">Al día siguiente</option>
                <option value="weekly">Cada semana</option>
                <option value="monthly">Cada mes</option>
              </select>
            </Field>
            {draft.data.recurrence && draft.data.recurrence !== "none" && (
              <Field label="Final de la serie (opcional)">
                <input
                  type="date"
                  value={draft.data.recurrenceEndDate || ""}
                  min={draft.data.dueDate || undefined}
                  readOnly={!editable}
                  onChange={(e) =>
                    setData({ recurrenceEndDate: e.target.value })
                  }
                />
              </Field>
            )}
            {draft.data.recurrence && draft.data.recurrence !== "none" && (
              <p className="muted">
                Al completar se crea una sola tarea con la siguiente fecha
                futura, sin sprint y con la lista de comprobación reiniciada.
                Zona horaria: {draft.data.timeZone || "UTC"}.
              </p>
            )}
            <div className="field relation-picks">
              <span>Depende de</span>
              <div>
                {(draft.data.dependencies || []).map((id: string) => {
                  const task = tasks.find((t) => t.id === id);
                  return (
                    <span className="relation-chip" key={id}>
                      {task && <StatusIcon status={task.data.status} />}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => task && open(task)}
                      >
                        {task?.title || "Tarea no disponible"}
                      </button>
                      {editable && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Quitar dependencia ${task?.title || ""}`.trim()}
                          onClick={() =>
                            setData({
                              dependencies: (
                                draft.data.dependencies || []
                              ).filter((d: string) => d !== id),
                            })
                          }
                        >
                          <X size={13} />
                        </button>
                      )}
                    </span>
                  );
                })}
                {editable && (
                  <select
                    aria-label="Añadir dependencia"
                    value=""
                    onChange={(e) =>
                      e.target.value &&
                      setData({
                        dependencies: [
                          ...(draft.data.dependencies || []),
                          e.target.value,
                        ],
                      })
                    }
                  >
                    <option value="">+ Añadir tarea previa…</option>
                    {tasks
                      .filter(
                        (r) => !(draft.data.dependencies || []).includes(r.id),
                      )
                      .map((r) => (
                        <option value={r.id} key={r.id}>
                          {r.title}
                        </option>
                      ))}
                  </select>
                )}
                {!editable && !(draft.data.dependencies || []).length && (
                  <span className="muted">Ninguna</span>
                )}
              </div>
            </div>
            <div
              className="field relation-picks"
              role="group"
              aria-label="Revisores"
            >
              <span>Revisores</span>
              <div>
                {members.map((m) => {
                  const on = (draft.data.reviewers || []).includes(m.id);
                  return (
                    <button
                      type="button"
                      key={m.id}
                      className={`reviewer-chip ${on ? "on" : ""}`}
                      aria-pressed={on}
                      disabled={!editable}
                      onClick={() =>
                        setData({
                          reviewers: on
                            ? (draft.data.reviewers || []).filter(
                                (r: string) => r !== m.id,
                              )
                            : [...(draft.data.reviewers || []), m.id],
                        })
                      }
                    >
                      <span className="avatar small">
                        {m.name?.slice(0, 2).toUpperCase()}
                      </span>
                      {m.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </details>
      ) : (
        !draft.data.personalNote &&
        ["project", "document"].includes(draft.kind) &&
        parentField
      )}
      {draft.kind === "task" && (
        <>
          {blockers.length > 0 && (
            <div className="blocked-notice">
              Pendiente de {blockers.length} tareas previas.
              <div className="relation-list">
                {blockers.map((r) => (
                  <button
                    className="text-button"
                    onClick={() => open(r)}
                    key={r.id}
                  >
                    {r.title}
                    <ArrowRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {backlinks.length > 0 && (
        <section>
          <h3>Referencias a este elemento</h3>
          {backlinks.map((r) => (
            <button className="linked-row" onClick={() => open(r)} key={r.id}>
              {r.title}
              <ArrowRight size={14} />
            </button>
          ))}
        </section>
      )}
      {draft.kind === "task" && (
        <ConfiguredTaskFields
          definitions={definitions}
          values={draft.data.customFields || {}}
          change={(customFields) => setData({ customFields })}
          editable={editable}
          members={members}
        />
      )}
      {snapshots.some((f) => !definitions.some((d) => d.id === f.id)) && (
        <section aria-label="Valores del proyecto de origen">
          <h3>Valores del proyecto de origen</h3>
          <p>
            Se conservan sin cambios hasta que la tarea utilice un proyecto con
            campos compatibles.
          </p>
          {snapshots
            .filter((f) => !definitions.some((d) => d.id === f.id))
            .map((f) => (
              <div className="custom-field-origin" key={f.id}>
                <strong>{f.name}</strong>
                <span>
                  {fieldValueLabel(f, draft.data.customFields?.[f.id], members)}
                </span>
                {editable && (
                  <button
                    type="button"
                    onClick={() => {
                      const values = { ...draft.data.customFields };
                      delete values[f.id];
                      setData({ customFields: values });
                    }}
                  >
                    Quitar valor conservado {f.name}
                  </button>
                )}
              </div>
            ))}
        </section>
      )}
      {["task", "project"].includes(draft.kind) && (
        <details
          className="more-fields custom-fields-details"
          open={
            Object.keys(draft.data.customFields || {}).some(
              (name) => !managed.has(name),
            ) || undefined
          }
        >
          <summary>Campos personalizados</summary>
          {Object.entries(draft.data.customFields || {})
            .filter(([name]) => !managed.has(name))
            .map(([name, value]) => (
              <div className="custom-field-row" key={name}>
                <Field label={name}>
                  {typeof value === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={value}
                      disabled={!editable}
                      onChange={(e) =>
                        setData({
                          customFields: {
                            ...draft.data.customFields,
                            [name]: e.target.checked,
                          },
                        })
                      }
                    />
                  ) : (
                    <input
                      type={typeof value === "number" ? "number" : "text"}
                      value={value == null ? "" : String(value)}
                      readOnly={!editable}
                      onChange={(e) =>
                        setData({
                          customFields: {
                            ...draft.data.customFields,
                            [name]:
                              typeof value === "number"
                                ? Number(e.target.value)
                                : e.target.value,
                          },
                        })
                      }
                    />
                  )}
                </Field>
                {editable && (
                  <button
                    className="icon-button danger"
                    aria-label={`Eliminar campo ${name}`}
                    onClick={() => {
                      const fields = { ...draft.data.customFields };
                      delete fields[name];
                      setData({ customFields: fields });
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          {editable && (
            <form
              className="custom-field-row"
              onSubmit={(e) => {
                e.preventDefault();
                const name = fieldName.trim();
                if (!name || Object.hasOwn(draft.data.customFields || {}, name))
                  return;
                setData({
                  customFields: {
                    ...draft.data.customFields,
                    [name]:
                      fieldType === "number"
                        ? 0
                        : fieldType === "boolean"
                          ? false
                          : "",
                  },
                });
                setFieldName("");
              }}
            >
              <Field label="Nombre del nuevo campo">
                <input
                  maxLength={80}
                  value={fieldName}
                  onChange={(e) => setFieldName(e.target.value)}
                  required
                />
              </Field>
              <Field label="Tipo de campo">
                <select
                  value={fieldType}
                  onChange={(e) => setFieldType(e.target.value)}
                >
                  <option value="text">Texto</option>
                  <option value="number">Número</option>
                  <option value="boolean">Sí / No</option>
                </select>
              </Field>
              <button>Añadir campo</button>
            </form>
          )}
        </details>
      )}
    </section>
  );
}
