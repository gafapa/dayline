import { useState } from "react";
import { Field, Modal } from "./components/Primitives";
import { api, send } from "./api";
import { useServerCommand } from "./useServerCommand";
import {
  fieldDefinitionSchema,
  fieldDefinitionsSchema,
  fieldTypeLabels,
  fieldTypes,
  type FieldDefinition,
  type CustomFieldValue,
} from "../shared/custom-fields";
import { CustomFieldInput } from "./CustomFieldInputs";
import type { Resource, User, Workspace } from "../shared/model";
export default function CustomFieldAdmin({
  project,
  workspace,
  user,
  members,
  refresh,
  close,
}: {
  project: Resource;
  workspace: Workspace;
  user: User;
  members: { id: string; name: string }[];
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const initial = fieldDefinitionsSchema.parse(
    project.data.fieldDefinitions || [],
  );
  const [definitions, setDefinitions] = useState<FieldDefinition[]>(initial),
    [version, setVersion] = useState(project.version),
    [selected, setSelected] = useState(initial[0]?.id || ""),
    [dirty, setDirty] = useState(false),
    [fillMissing, setFillMissing] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const command = useServerCommand(
    user.id,
    workspace.id,
    `fields:${project.id}`,
    async () => {
      await refresh();
      setDirty(false);
      close();
    },
  );
  const field = definitions.find((f) => f.id === selected),
    isExisting = !!field && initial.some((f) => f.id === field.id);
  const update = (patch: Partial<FieldDefinition>) => {
    if (!field) return;
    setDefinitions((values) =>
      values.map((f) => (f.id === field.id ? { ...f, ...patch } : f)),
    );
    setDirty(true);
    setPreview(null);
  };
  const restore = async () => {
    setDefinitions(initial);
    setVersion(project.version);
    setSelected(initial[0]?.id || "");
    setDirty(false);
    setPreview(null);
    setError("");
  };
  return (
    <Modal
      title={`Campos de tareas · ${project.title}`}
      close={close}
      className="field-admin-dialog"
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const parsed = fieldDefinitionsSchema.parse(definitions);
            if (preview) {
              await command.run(
                `/workspaces/${workspace.id}/projects/${project.id}/fields/apply`,
                {
                  definitions: parsed,
                  expectedVersion: version,
                  fillMissing,
                  fingerprint: preview.fingerprint,
                },
              );
              await refresh();
              setDirty(false);
              close();
            } else
              setPreview(
                await api(
                  `/workspaces/${workspace.id}/projects/${project.id}/fields/preview`,
                  send({
                    definitions: parsed,
                    expectedVersion: version,
                    fillMissing,
                  }),
                ),
              );
          } catch (e) {
            setPreview(null);
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {command.recovery}
        {error && <p role="alert">{error}</p>}
        <p>
          Define los datos que necesita cada tarea. Renombrar o archivar
          conserva los valores guardados.
        </p>
        {version !== project.version && (
          <p role="status">
            El proyecto ha cambiado mientras editabas. Revisa su configuración
            antes de confirmar.
          </p>
        )}
        <div className="field-admin-layout">
          <div>
            <Field label="Campos del proyecto">
              <select
                size={Math.min(8, Math.max(3, definitions.length + 1))}
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {definitions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name || "Campo sin nombre"}
                    {f.archived ? " (archivado)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              disabled={definitions.length >= 50}
              onClick={() => {
                const next = fieldDefinitionSchema.parse({
                  id: crypto.randomUUID(),
                  name: "Nuevo campo",
                  type: "text",
                });
                setDefinitions((values) => [...values, next]);
                setSelected(next.id);
                setDirty(true);
                setPreview(null);
              }}
            >
              Añadir campo configurado
            </button>
            <p className="muted">
              {definitions.length} de 50 campos, incluidos los archivados.
            </p>
          </div>
          {field ? (
            <div className="field-admin-editor">
              <Field label="Nombre del campo">
                <input
                  required
                  maxLength={80}
                  value={field.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              <Field label="Tipo del campo">
                <select
                  disabled={isExisting}
                  value={field.type}
                  onChange={(e) =>
                    update({
                      type: e.target.value as FieldDefinition["type"],
                      options: [],
                      defaultValue: undefined,
                      min: undefined,
                      max: undefined,
                    })
                  }
                >
                  {fieldTypes.map((type) => (
                    <option key={type} value={type}>
                      {fieldTypeLabels[type]}
                    </option>
                  ))}
                </select>
              </Field>
              {isExisting && (
                <p className="muted">
                  El tipo se mantiene para conservar los valores. Puedes
                  archivar este campo y crear otro.
                </p>
              )}
              <Field label="Descripción del campo">
                <textarea
                  maxLength={500}
                  rows={2}
                  value={field.description}
                  onChange={(e) => update({ description: e.target.value })}
                />
              </Field>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) => update({ required: e.target.checked })}
                />
                Obligatorio en las tareas
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={field.archived}
                  onChange={(e) => update({ archived: e.target.checked })}
                />
                Archivar campo
              </label>
              {field.type === "number" && (
                <div className="form-grid">
                  <Field label="Número mínimo">
                    <input
                      type="number"
                      step="any"
                      value={field.min ?? ""}
                      onChange={(e) =>
                        update({
                          min:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="Número máximo">
                    <input
                      type="number"
                      step="any"
                      value={field.max ?? ""}
                      onChange={(e) =>
                        update({
                          max:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                </div>
              )}
              {field.type === "text" && (
                <Field label="Máximo de caracteres">
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={field.maxLength}
                    onChange={(e) =>
                      update({ maxLength: Number(e.target.value) })
                    }
                  />
                </Field>
              )}
              {["select", "multiselect"].includes(field.type) && (
                <section aria-label="Opciones del campo">
                  <h3>Opciones</h3>
                  {field.options.map((option, index) => (
                    <div className="field-option-row" key={option.id}>
                      <Field label={`Opción ${index + 1}`}>
                        <input
                          required
                          maxLength={100}
                          value={option.label}
                          onChange={(e) =>
                            update({
                              options: field.options.map((o) =>
                                o.id === option.id
                                  ? { ...o, label: e.target.value }
                                  : o,
                              ),
                            })
                          }
                        />
                      </Field>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={option.archived}
                          onChange={(e) =>
                            update({
                              options: field.options.map((o) =>
                                o.id === option.id
                                  ? { ...o, archived: e.target.checked }
                                  : o,
                              ),
                            })
                          }
                        />
                        Archivar opción
                      </label>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={field.options.length >= 50}
                    onClick={() =>
                      update({
                        options: [
                          ...field.options,
                          {
                            id: crypto.randomUUID(),
                            label: `Opción ${field.options.length + 1}`,
                            archived: false,
                          },
                        ],
                      })
                    }
                  >
                    Añadir opción
                  </button>
                </section>
              )}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={field.defaultValue !== undefined}
                  onChange={(e) =>
                    update({
                      defaultValue: e.target.checked
                        ? field.type === "number"
                          ? 0
                          : field.type === "boolean"
                            ? false
                            : field.type === "multiselect"
                              ? []
                              : null
                        : undefined,
                    })
                  }
                />
                Usar valor predeterminado
              </label>
              {field.defaultValue !== undefined && (
                <CustomFieldInput
                  field={{ ...field, archived: false, required: false }}
                  label="Valor predeterminado"
                  value={field.defaultValue}
                  change={(value: CustomFieldValue) =>
                    update({ defaultValue: value })
                  }
                  members={members}
                />
              )}
              {!isExisting && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setDefinitions((values) =>
                      values.filter((f) => f.id !== field.id),
                    );
                    setSelected(
                      definitions.find((f) => f.id !== field.id)?.id || "",
                    );
                    setDirty(true);
                    setPreview(null);
                  }}
                >
                  Quitar campo sin guardar
                </button>
              )}
            </div>
          ) : (
            <p>Selecciona un campo o crea el primero.</p>
          )}
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={fillMissing}
            onChange={(e) => {
              setFillMissing(e.target.checked);
              setDirty(true);
              setPreview(null);
            }}
          />
          Aplicar también los predeterminados opcionales a tareas sin valor
        </label>
        {preview && (
          <div className="field-plan" role="status">
            <p>
              Se guardarán {definitions.length} definiciones y se actualizarán{" "}
              {preview.changedTaskCount} tareas.
            </p>
            <p>
              Los valores existentes se conservan. Las tareas y el proyecto se
              guardan juntos.
            </p>
          </div>
        )}
        {!navigator.onLine && (
          <p>
            Conéctate para revisar y aplicar la configuración.
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={() => void restore()}>
            Restaurar configuración del proyecto
          </button>
          <button type="button" onClick={close}>
            Cerrar
          </button>
          <button
            className="primary"
            disabled={
              busy || !command.ready || !navigator.onLine
            }
          >
            {busy
              ? "Comprobando…"
              : preview
                ? "Confirmar configuración"
                : "Revisar configuración"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
