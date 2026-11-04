import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Field, Modal } from "./components/Primitives";
import type { Resource, User, Workspace } from "../shared/model";
import { statusLabels, taskStatuses } from "../shared/task-status";
import {
  checkWorkflowChange,
  workflowStatesSchema,
  type WorkflowState,
} from "../shared/workflow";

const nextName = (states: WorkflowState[]) => {
  let n = states.length + 1;
  while (states.some((s) => s.name === `Nuevo estado ${n}`)) n++;
  return `Nuevo estado ${n}`;
};
/** Project workflow configuration saved through the durable metadata outbox. */
export default function WorkflowAdmin({
  project,
  workspace,
  user,
  tasks,
  save,
  close,
}: {
  project: Resource;
  workspace: Workspace;
  user: User;
  tasks: Resource[];
  save: (resource: Resource) => Promise<unknown>;
  close: () => void;
}) {
  const initial = workflowStatesSchema.safeParse(
      project.data.workflowStates || [],
    ),
    saved: WorkflowState[] = initial.success ? initial.data : [];
  const [states, setStates] = useState<WorkflowState[]>(saved),
    [version, setVersion] = useState(project.version),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (next: WorkflowState[]) => {
    setStates(next);
    setDirty(true);
    setError("");
  };
  const update = (id: string, patch: Partial<WorkflowState>) =>
    change(states.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (id: string, offset: number) => {
    const state = states.find((s) => s.id === id)!,
      same = states.filter((s) => s.category === state.category),
      index = same.findIndex((s) => s.id === id),
      target = same[index + offset];
    if (!target) return;
    const next = [...states],
      a = next.findIndex((s) => s.id === id),
      b = next.findIndex((s) => s.id === target.id);
    [next[a], next[b]] = [next[b], next[a]];
    change(next);
  };
  const usage = (id: string) =>
    tasks.filter(
      (t) =>
        t.kind === "task" &&
        !t.deleted_at &&
        t.data.projectId === project.id &&
        t.data.stateId === id,
    ).length;
  const discard = async () => {
    setStates(saved);
    setVersion(project.version);
    setDirty(false);
    setError("");
  };
  return (
    <Modal
      title={`Flujo de estados · ${project.title}`}
      close={close}
      className="field-admin-dialog workflow-admin-dialog"
    >
      <form
        className="modal-body"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const parsed = workflowStatesSchema.safeParse(states);
            if (!parsed.success)
              throw new Error(
                parsed.error.issues[0]?.message ||
                  "Revisa los nombres de los estados.",
              );
            checkWorkflowChange(parsed.data, saved);
            if (version !== project.version)
              throw new Error(
                "El proyecto ha cambiado mientras editabas. Descarta los cambios y revisa el flujo actual.",
              );
            await save({
              ...project,
              data: { ...project.data, workflowStates: parsed.data },
            });
            setDirty(false);
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <p role="alert">{error}</p>}
        <p>
          Nombra las etapas reales de este proyecto. Cada estado pertenece a
          una categoría fija, que usan los informes, los sprints y las
          automatizaciones. Las categorías sin estados propios se muestran con
          su nombre habitual.
        </p>
        {version !== project.version && (
          <p role="status">
            El proyecto ha cambiado mientras editabas. Revisa su configuración
            antes de confirmar.
          </p>
        )}
        {taskStatuses.map((category) => {
          const group = states.filter((s) => s.category === category);
          return (
            <fieldset key={category} className="workflow-category">
              <legend>{statusLabels[category]}</legend>
              {!group.length && (
                <p className="muted">
                  Sin estados propios: se muestra «{statusLabels[category]}».
                </p>
              )}
              {group.map((state, index) => {
                const used = usage(state.id);
                return (
                  <div className="workflow-state-row" key={state.id}>
                    <Field label={`Nombre del estado ${index + 1} de ${statusLabels[category]}`}>
                      <input
                        required
                        maxLength={60}
                        value={state.name}
                        onChange={(e) =>
                          update(state.id, { name: e.target.value })
                        }
                      />
                    </Field>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={state.archived}
                        onChange={(e) =>
                          update(state.id, { archived: e.target.checked })
                        }
                      />
                      Archivado
                    </label>
                    <span className="muted">
                      {used === 1 ? "1 tarea" : `${used} tareas`}
                    </span>
                    <div className="workflow-state-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Subir ${state.name}`}
                        disabled={index === 0}
                        onClick={() => move(state.id, -1)}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Bajar ${state.name}`}
                        disabled={index === group.length - 1}
                        onClick={() => move(state.id, 1)}
                      >
                        <ArrowDown size={16} />
                      </button>
                      {!saved.some((s) => s.id === state.id) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            change(states.filter((s) => s.id !== state.id))
                          }
                        >
                          Quitar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                disabled={states.length >= 40}
                onClick={() =>
                  change([
                    ...states,
                    {
                      id: crypto.randomUUID(),
                      name: nextName(states),
                      category,
                      archived: false,
                    },
                  ])
                }
              >
                Añadir estado a {statusLabels[category]}
              </button>
            </fieldset>
          );
        })}
        <p className="muted">
          {states.length} de 40 estados, incluidos los archivados. Los estados
          guardados se archivan en lugar de eliminarse para conservar el
          historial de las tareas.
        </p>
        <div className="form-actions">
          {dirty && (
            <button type="button" onClick={() => void discard()}>
              Descartar cambios del flujo
            </button>
          )}
          <button type="button" onClick={close}>
            Cerrar
          </button>
          <button className="primary" disabled={busy || !dirty}>
            Guardar flujo
          </button>
        </div>
      </form>
    </Modal>
  );
}
