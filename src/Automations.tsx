import { useCallback, useEffect, useState } from "react";
import { Field } from "./components/Primitives";
import { api, send } from "./api";
import {
  actionLabels,
  runStatusLabels,
  triggerLabels,
} from "../shared/automation";
import { statusLabels, taskStatuses, type Resource } from "../shared/model";

export function AutomationFields({
  draft,
  members,
  editable,
  setData,
}: {
  draft: Resource;
  members: any[];
  editable: boolean;
  setData: (patch: any) => void;
}) {
  const data = draft.data,
    scheduled = ["task_overdue", "daily_summary"].includes(data.trigger);
  return (
    <section className="automation-fields">
      <h3>Regla de ejecución</h3>
      <p className="muted">
        Se aplica a las tareas del proyecto seleccionado. Las reglas sin
        proyecto se reservan a administradores. Los cambios automáticos no
        encadenan otras reglas.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!data.enabled}
          disabled={!editable}
          onChange={(e) => setData({ enabled: e.target.checked })}
        />
        Activar regla
      </label>
      <div className="form-grid">
        <Field label="Cuándo">
          <select
            value={data.trigger || ""}
            disabled={!editable}
            onChange={(e) =>
              setData({
                trigger: e.target.value,
                ...(e.target.value === "daily_summary"
                  ? { action: "notify" }
                  : {}),
              })
            }
          >
            <option value="" disabled>
              Selecciona un evento
            </option>
            {Object.entries(triggerLabels)
              .filter(([key]) => key !== "recurrence")
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Acción automática">
          <select
            value={data.action || ""}
            disabled={!editable || data.trigger === "daily_summary"}
            onChange={(e) =>
              setData({ action: e.target.value, actionValue: "" })
            }
          >
            <option value="" disabled>
              Selecciona una acción
            </option>
            {Object.entries(actionLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            data.action === "set_status"
              ? "Estado de destino"
              : "Persona destinataria"
          }
        >
          <select
            value={data.actionValue || ""}
            disabled={!editable || !data.action}
            onChange={(e) => setData({ actionValue: e.target.value })}
          >
            <option value="">Selecciona un valor</option>
            {data.action === "set_status"
              ? taskStatuses.map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))
              : members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
          </select>
        </Field>
        <Field label="Solo tareas con etiqueta">
          <input
            value={data.matchLabel || ""}
            readOnly={!editable}
            maxLength={80}
            onChange={(e) => setData({ matchLabel: e.target.value })}
            placeholder="Cualquier etiqueta"
          />
        </Field>
        <Field label="Solo tareas en estado">
          <select
            value={data.matchStatus || ""}
            disabled={!editable}
            onChange={(e) =>
              setData({ matchStatus: e.target.value || undefined })
            }
          >
            <option value="">Cualquier estado</option>
            {taskStatuses.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {scheduled && (
        <div className="form-grid">
          <Field label="Hora de comprobación">
            <input
              type="time"
              value={data.timeOfDay || "09:00"}
              readOnly={!editable}
              onChange={(e) => setData({ timeOfDay: e.target.value })}
            />
          </Field>
          <Field label="Zona horaria de la regla">
            <input
              value={data.timeZone || "UTC"}
              readOnly={!editable}
              placeholder="Europe/Madrid"
              onChange={(e) => setData({ timeZone: e.target.value })}
            />
          </Field>
        </div>
      )}
      {data.trigger === "task_overdue" && (
        <p className="muted">
          Se ejecuta una vez por tarea y fecha límite, a partir de la hora
          indicada. Las tareas completadas o canceladas quedan excluidas.
        </p>
      )}
      {data.trigger === "daily_summary" && (
        <p className="muted">
          Una notificación por día con los recuentos que ambas personas pueden
          consultar. Las horas se interpretan en la zona indicada.
        </p>
      )}
    </section>
  );
}
const reasonLabels: Record<string, string> = {
  rule_changed:
    "La regla cambió antes de ejecutarse. Reintenta para aplicar su configuración actual.",
  permissions_changed: "El autor perdió permisos de edición.",
  target_unavailable: "El elemento dejó de estar disponible.",
  rule_unavailable: "La regla se pausó o dejó de estar disponible.",
  conditions_changed: "La tarea ya no cumple las condiciones.",
  recipient_unavailable: "El destinatario perdió acceso.",
  invalid_rule: "Revisa la configuración de la regla.",
  execution_failed: "La ejecución falló. Se reintenta hasta tres veces.",
  result_unavailable: "El resultado ya no está disponible para tu cuenta.",
};
function AttemptHistory({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [attempts, setAttempts] = useState<any[]>([]),
    [before, setBefore] = useState<number | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const load = async (older = false) => {
    setBusy(true);
    try {
      const result = await api(
        `/workspaces/${workspaceId}/automations/runs/${runId}/attempts${older && before ? `?before=${before}` : ""}`,
      );
      setAttempts((current) =>
        older ? [...current, ...result.attempts] : result.attempts,
      );
      setBefore(result.nextBefore);
      setLoaded(true);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !busy) void load();
      }}
    >
      <summary>Historial de intentos</summary>
      {error && <p role="alert">{error}</p>}
      <ol>
        {attempts.map((attempt) => (
          <li key={attempt.attempt}>
            Intento {attempt.attempt}: {runStatusLabels[attempt.status]} ·{" "}
            {new Date(attempt.finished_at).toLocaleString("es")}
            {attempt.result?.reason && (
              <p>
                {reasonLabels[attempt.result.reason] || "Revisa este intento."}
              </p>
            )}
          </li>
        ))}
      </ol>
      {loaded && !attempts.length && <p>Todavía no se ha intentado.</p>}
      {before && (
        <button disabled={busy} onClick={() => void load(true)}>
          Cargar intentos anteriores
        </button>
      )}
      <button
        disabled={busy}
        className="text-button"
        onClick={() => void load()}
      >
        Actualizar intentos
      </button>
    </details>
  );
}
export function AutomationHistory({
  workspaceId,
  resources,
  open,
}: {
  workspaceId: string;
  resources: Resource[];
  open: (resource: Resource) => void;
}) {
  const [runs, setRuns] = useState<any[]>([]),
    [worker, setWorker] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!navigator.onLine) {
      setError("Conéctate para consultar el historial del servidor.");
      return;
    }
    try {
      const result = await api(`/workspaces/${workspaceId}/automations/runs`);
      setRuns(result.runs);
      setWorker(result.worker);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    window.addEventListener("online", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", load);
    };
  }, [load]);
  return (
    <section className="planning-section automation-history">
      <div className="section-heading">
        <h2>Ejecuciones automáticas</h2>
        <button disabled={busy} onClick={() => void load()}>
          Actualizar historial
        </button>
      </div>
      <p className="muted">
        El servidor revisa la cola cada 15 segundos.{" "}
        {worker?.lastTick
          ? `Última revisión: ${new Date(worker.lastTick).toLocaleString("es")}.`
          : "Esperando la primera revisión."}
      </p>
      {worker?.lastError && (
        <p role="alert">
          La última revisión encontró un error. La cola se conserva para el
          próximo intento.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!runs.length && !error && (
        <p>
          Aún no hay ejecuciones. Activa una regla o completa una tarea
          recurrente.
        </p>
      )}
      {runs.map((run) => {
        const rule = resources.find((r) => r.id === run.rule_id),
          target = resources.find((r) => r.id === run.target_id),
          result = resources.find((r) => r.id === run.result?.resourceId);
        return (
          <article className="automation-run" key={run.id}>
            <div>
              <strong>{rule?.title || triggerLabels[run.trigger]}</strong>
              <p>
                {triggerLabels[run.trigger]} · {runStatusLabels[run.status]} ·{" "}
                {run.attempts} intentos
              </p>
              {target && (
                <button className="text-button" onClick={() => open(target)}>
                  {target.title}
                </button>
              )}
              <time>{new Date(run.created_at).toLocaleString("es")}</time>
              {run.result?.reason && (
                <p>
                  {reasonLabels[run.result.reason] || "Revisa esta ejecución."}
                </p>
              )}
              {run.result?.seriesEnded && (
                <p>La serie alcanzó su fecha final.</p>
              )}
              {run.result?.unchanged && (
                <p>El elemento ya tenía el valor indicado.</p>
              )}
              {result && (
                <button className="text-button" onClick={() => open(result)}>
                  Ver resultado
                </button>
              )}
              <AttemptHistory workspaceId={workspaceId} runId={run.id} />
            </div>
            {run.canRetry && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(
                      `/workspaces/${workspaceId}/automations/runs/${run.id}/retry`,
                      send({}),
                    );
                    await load();
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Reintentar
              </button>
            )}
          </article>
        );
      })}
      {runs.length === 200 && (
        <p className="muted">
          Se muestran las últimas 200 ejecuciones accesibles.
        </p>
      )}
    </section>
  );
}
