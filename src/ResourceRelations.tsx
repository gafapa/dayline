import { useState } from "react";
import { Plus, ArrowRight, Trash2 } from "lucide-react";
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
  const backlinks = resources.filter(
    (r) =>
      r.id !== draft.id &&
      r.kind === "document" &&
      documentReferences(r.data.content).includes(draft.id),
  );
  return (
    <section className="task-extra-fields">
      {!draft.data.personalNote &&
        ["project", "document", "task"].includes(draft.kind) && (
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
        )}
      {draft.kind === "task" && (
        <>
          <div className="form-grid">
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
          </div>
          <div className="form-grid">
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
          </div>
          {draft.data.recurrence && draft.data.recurrence !== "none" && (
            <p className="muted">
              Al completar se crea una sola tarea con la siguiente fecha futura,
              sin sprint y con la lista de comprobación reiniciada. Zona
              horaria: {draft.data.timeZone || "UTC"}.
            </p>
          )}
          <Field label="Depende de">
            <select
              multiple
              disabled={!editable}
              value={draft.data.dependencies || []}
              onChange={(e) =>
                setData({
                  dependencies: [...e.target.selectedOptions].map(
                    (o) => o.value,
                  ),
                })
              }
            >
              {tasks.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </Field>
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
          <Field label="Revisores">
            <select
              multiple
              disabled={!editable}
              value={draft.data.reviewers || []}
              onChange={(e) =>
                setData({
                  reviewers: [...e.target.selectedOptions].map((o) => o.value),
                })
              }
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      {children.length > 0 && (
        <section>
          <h3>{draft.kind === "task" ? "Subtareas" : "Elementos anidados"}</h3>
          <div className="relation-list">
            {children.map((r) => (
              <button className="linked-row" onClick={() => open(r)} key={r.id}>
                {r.title}
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
        <section>
          <h3>Campos personalizados</h3>
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
        </section>
      )}
    </section>
  );
}
