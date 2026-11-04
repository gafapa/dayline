import { useEffect, useMemo, useState } from "react";
import type { Resource, User, Workspace } from "../shared/model";
import { Field } from "./components/Primitives";
import { useDraft } from "./useDraft";
import { reportCSV } from "../shared/analytics";
import { validTimeZone } from "../shared/time";
import {
  elapsedLogSeconds,
  filterTimeEntries,
  formatLogDuration,
  MAX_LOG_SECONDS,
  retainTimeLogContexts,
  timeEntrySummary,
  timeLogSchema,
  todayForLog,
  validateTimeLog,
  type TimeLog,
} from "../shared/time-tracking";

type Props = {
  resources: Resource[];
  members: { id: string; name: string }[];
  user: User;
  workspace: Workspace;
  canEdit: boolean;
  timeZone: string;
  focusId: string | null;
  open: (resource: Resource) => void;
  startNew: boolean;
  close: (createNew?: boolean) => void;
  save: (resource: Resource) => Promise<Resource | undefined>;
};
type Form = {
  id: string;
  version: number;
  title: string;
  description: string;
  projectId: string;
  targetId: string;
  shared: boolean;
  mode: "manual" | "timer";
  date: string;
  timeZone: string;
  hours: number;
  minutes: number;
  seconds: number;
};
export default function TimeTracking({
  resources,
  members,
  user,
  workspace,
  canEdit,
  timeZone,
  focusId,
  open,
  close,
  startNew,
  save,
}: Props) {
  const zone = validTimeZone(timeZone) ? timeZone : "UTC",
    today = todayForLog(zone),
    source = resources.find(
      (entry) => entry.kind === "time_entry" && entry.id === focusId,
    );
  const fresh = (entry?: Resource): Form => {
    const log = timeLogSchema.safeParse(entry?.data.timeLog),
      seconds = log.success ? log.data.seconds : 1800;
    return {
      id: entry?.id || crypto.randomUUID(),
      version: entry?.version || 0,
      title: entry?.title || "",
      description: entry?.data.description || "",
      projectId: entry?.data.projectId || "",
      targetId: entry?.data.targetId || "",
      shared: !!entry && !entry.data.ownerId,
      mode: log.success ? log.data.mode : "manual",
      date: log.success ? log.data.date : today,
      timeZone: log.success ? log.data.timeZone : zone,
      hours: Math.floor(seconds / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
      seconds: seconds % 60,
    };
  };
  const [form, setForm] = useState(() => fresh(source)),
    [editing, setEditing] = useState(!!focusId || startNew),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [limit, setLimit] = useState(100);
  const [from, setFrom] = useState(today.slice(0, 8) + "01"),
    [to, setTo] = useState(today),
    [projectId, setProjectId] = useState(""),
    [authorId, setAuthorId] = useState(user.id),
    [descendants, setDescendants] = useState(true),
    [archives, setArchives] = useState(false);
  const unavailable = !!focusId && !source,
    editable =
      canEdit &&
      (!source || source.created_by === user.id) &&
      !source?.deleted_at;
  const draft = useDraft(
    user.id,
    `${workspace.id}:time-entry:${focusId || "new"}`,
    form,
    dirty,
    (value) => {
      if (
        !value ||
        typeof value.id !== "string" ||
        typeof value.title !== "string" ||
        !Number.isInteger(value.version) ||
        !["manual", "timer"].includes(value.mode) ||
        typeof value.date !== "string" ||
        typeof value.shared !== "boolean" ||
        ![value.hours, value.minutes, value.seconds].every(Number.isInteger)
      )
        throw new Error("Invalid local time draft");
      if (source && value.id !== source.id)
        throw new Error("Mismatched local time draft");
      setForm(value);
      setEditing(true);
      setDirty(true);
    },
    !unavailable,
  );
  useEffect(() => {
    if (!dirty && source) setForm(fresh(source));
  }, [source?.version, dirty]);
  const patch = (value: Partial<Form>) => {
    setForm((previous) => ({ ...previous, ...value }));
    setDirty(true);
    setError("");
  };
  const byId = useMemo(
      () => new Map(resources.map((resource) => [resource.id, resource])),
      [resources],
    ),
    names = new Map(members.map((member) => [member.id, member.name]));
  const projects = resources.filter(
    (resource) =>
      resource.kind === "project" &&
      !resource.deleted_at &&
      (!resource.data.archived || resource.id === form.projectId),
  );
  const tasks = resources.filter(
    (resource) =>
      resource.kind === "task" &&
      !resource.deleted_at &&
      (!resource.data.archived || resource.id === form.targetId) &&
      (!form.projectId ||
        resource.data.projectId === form.projectId ||
        resource.id === form.targetId),
  );
  const running = filterTimeEntries(resources, {
    from: "0001-01-01",
    to: "9999-12-31",
    projectId: "",
    authorId: user.id,
    includeDescendants: true,
    includeArchived: true,
  }).filter((entry) => entry.data.timeLog?.status === "running");
  const filtered = useMemo(() => {
    try {
      return {
        entries: filterTimeEntries(resources, {
          from,
          to,
          projectId,
          authorId,
          includeDescendants: descendants,
          includeArchived: archives,
        }),
        error: "",
      };
    } catch (issue) {
      return { entries: [], error: (issue as Error).message };
    }
  }, [resources, from, to, projectId, authorId, descendants, archives]);
  const summary = useMemo(
    () => timeEntrySummary(filtered.entries),
    [filtered.entries],
  );
  const check = (resource: Resource) => {
    validateTimeLog(resource.data.timeLog);
    retainTimeLogContexts(
      resource,
      resources,
      source?.id === resource.id
        ? source.data.timeLogContexts || []
        : resource.data.timeLogContexts || [],
    );
  };
  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const persist = () =>
    perform(async () => {
      if (!editable || !form.title.trim())
        throw new Error("Escribe una descripción breve para el registro.");
      let log: TimeLog;
      if (source?.data.timeLog?.mode === "timer")
        log = { ...source.data.timeLog, date: form.date };
      else if (form.mode === "timer")
        log = {
          date: form.date,
          timeZone: form.timeZone,
          mode: "timer",
          status: "running",
          seconds: 0,
          startedAt: new Date().toISOString(),
        };
      else
        log = {
          date: form.date,
          timeZone: form.timeZone,
          mode: "manual",
          status: "recorded",
          seconds: form.hours * 3600 + form.minutes * 60 + form.seconds,
        };
      const data = {
        ...(source?.data || {}),
        description: form.description,
        timeLog: log,
        ...(form.projectId ? { projectId: form.projectId } : {}),
        ...(form.targetId ? { targetId: form.targetId } : {}),
        ...(!form.shared ? { ownerId: user.id } : {}),
      };
      const resource = {
        ...(source || {}),
        id: form.id,
        workspace_id: workspace.id,
        kind: "time_entry",
        title: form.title.trim(),
        data,
        version: form.version,
        created_by: user.id,
        created_at: source?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      } as Resource;
      check(resource);
      const saved = await save(resource);
      await draft.clear();
      setDirty(false);
      setMessage(
        "Registro guardado en la cola local. La cabecera indica cuándo está sincronizado.",
      );
      if (saved) open(saved);
    });
  const stop = (entry: Resource) =>
    perform(async () => {
      if (dirty && entry.id === form.id)
        throw new Error("Guarda o descarta primero el borrador abierto.");
      const log = entry.data.timeLog as TimeLog,
        stoppedAt = new Date().toISOString(),
        seconds = Math.floor(
          (Date.parse(stoppedAt) - Date.parse(log.startedAt!)) / 1000,
        );
      const resource = {
        ...entry,
        data: {
          ...entry.data,
          timeLog: { ...log, status: "recorded", stoppedAt, seconds },
        },
      };
      check(resource);
      const saved = await save(resource);
      if (saved) open(saved);
    });
  const reset = () =>
    perform(async () => {
      await draft.clear();
      setForm(fresh(source));
      setDirty(false);
      if (!source) setEditing(false);
    });
  const remove = () =>
    perform(async () => {
      if (
        !source ||
        !confirm("¿Eliminar este registro de tiempo y su borrador local?")
      )
        return;
      await save({ ...source, deleted_at: new Date().toISOString() });
      await draft.clear();
      setDirty(false);
      close();
    });
  const csv = () => {
    const rows = [
      [
        "Fecha de imputación",
        "Autor",
        "ID del autor",
        "Proyecto original",
        "Tarea",
        "Descripción",
        "Notas",
        "Segundos",
        "Horas",
        "Origen",
        "Visibilidad",
        "Inicio UTC",
        "Fin UTC",
      ],
      ...filtered.entries
        .filter((entry) => entry.data.timeLog.status === "recorded")
        .map((entry) => {
          const log = entry.data.timeLog as TimeLog;
          return [
            log.date,
            names.get(entry.created_by) || "Antiguo miembro",
            entry.created_by,
            byId.get(entry.data.projectId)?.title || "Sin proyecto",
            byId.get(entry.data.targetId)?.title || "",
            entry.title,
            entry.data.description || "",
            log.seconds,
            log.seconds / 3600,
            log.mode,
            entry.data.ownerId ? "Personal" : "Compartido",
            log.startedAt || "",
            log.stoppedAt || "",
          ];
        }),
    ];
    const url = URL.createObjectURL(
        new Blob([reportCSV(rows)], { type: "text/csv;charset=utf-8" }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = `tiempo-${from}-${to}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const table = (
    title: string,
    rows: [string, number][],
    label: (id: string) => string,
  ) => (
    <section className="time-breakdown" aria-label={title}>
      <h3>{title}</h3>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th scope="col">{title.replace("Tiempo por ", "")}</th>
              <th scope="col">Duración</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, seconds]) => (
              <tr key={id}>
                <th scope="row">{label(id)}</th>
                <td>{formatLogDuration(seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Sin tiempo registrado en este periodo.</p>
      )}
    </section>
  );
  return (
    <div className="time-workspace">
      <div className="time-heading">
        <p>
          Registra trabajo manualmente o utiliza un reloj. El seguimiento es
          opcional.
        </p>
        {canEdit && (
          <button
            className="primary"
            onClick={() => {
              if (focusId) {
                close(true);
                return;
              }
              setEditing(true);
            }}
          >
            Nuevo registro
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {draft.issue && <p role="alert">{draft.issue}</p>}
      {unavailable && (
        <p role="alert">
          El registro no está disponible en esta copia. Verifica la conexión y
          los permisos.
        </p>
      )}
      {running.length > 0 && (
        <section
          className="time-running"
          aria-label="Mis temporizadores activos"
        >
          <h2>Temporizadores activos</h2>
          <p>
            No se incluyen en el total hasta detenerlos. Puedes volver a
            abrirlos después de recargar o trabajar sin conexión.
          </p>
          {running.map((entry) => (
            <div className="time-running-row" key={entry.id}>
              <button className="text-button" onClick={() => open(entry)}>
                {entry.title}
              </button>
              <RunningClock entry={entry} />
              <button
                disabled={!canEdit || busy || (dirty && form.id === entry.id)}
                onClick={() => void stop(entry)}
              >
                Detener {entry.title}
              </button>
            </div>
          ))}
        </section>
      )}
      {editing && !unavailable && (
        <section className="time-editor" aria-label="Editar registro de tiempo">
          <h2>{source ? "Registro de tiempo" : "Nuevo registro de tiempo"}</h2>
          {source?.deleted_at ? (
            <>
              <p>El registro está en la papelera.</p>
              {canEdit && source.created_by === user.id && (
                <button
                  onClick={() =>
                    void perform(async () => {
                      await save({ ...source, deleted_at: null });
                      close();
                    })
                  }
                >
                  Restaurar registro
                </button>
              )}
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void persist();
              }}
            >
              <fieldset
                disabled={!editable || !draft.ready || busy}
                className="time-form-grid"
              >
                <Field label="Descripción del trabajo">
                  <input
                    value={form.title}
                    required
                    maxLength={500}
                    onChange={(event) => patch({ title: event.target.value })}
                  />
                </Field>
                <Field label="Fecha de imputación">
                  <input
                    type="date"
                    required
                    value={form.date}
                    onChange={(event) => patch({ date: event.target.value })}
                  />
                </Field>
                <Field label="Origen del registro">
                  <select
                    value={form.mode}
                    disabled={!!source}
                    onChange={(event) =>
                      patch({ mode: event.target.value as Form["mode"] })
                    }
                  >
                    <option value="manual">Duración manual</option>
                    <option value="timer">Temporizador</option>
                  </select>
                </Field>
                <Field label="Proyecto del registro">
                  <select
                    value={form.projectId}
                    disabled={!!source}
                    onChange={(event) =>
                      patch({ projectId: event.target.value, targetId: "" })
                    }
                  >
                    <option value="">Sin proyecto</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Tarea del registro">
                  <select
                    value={form.targetId}
                    disabled={!!source}
                    onChange={(event) => {
                      const task = byId.get(event.target.value);
                      patch({
                        targetId: event.target.value,
                        ...(task
                          ? { projectId: task.data.projectId || "" }
                          : {}),
                      });
                    }}
                  >
                    <option value="">Sin tarea</option>
                    {tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="muted">
                  Zona del registro: {form.timeZone}. Las relaciones y la
                  visibilidad quedan fijadas al crearlo.
                </p>
                {form.mode === "manual" && (
                  <div className="time-duration">
                    <Field label="Horas registradas">
                      <input
                        type="number"
                        min={0}
                        max={168}
                        step={1}
                        required
                        value={form.hours}
                        onChange={(event) =>
                          patch({ hours: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Minutos registrados">
                      <input
                        type="number"
                        min={0}
                        max={59}
                        step={1}
                        required
                        value={form.minutes}
                        onChange={(event) =>
                          patch({ minutes: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Segundos registrados">
                      <input
                        type="number"
                        min={0}
                        max={59}
                        step={1}
                        required
                        value={form.seconds}
                        onChange={(event) =>
                          patch({ seconds: Number(event.target.value) })
                        }
                      />
                    </Field>
                  </div>
                )}
                {source?.data.timeLog?.mode === "timer" && (
                  <p>
                    Inicio:{" "}
                    {displayInstant(
                      source.data.timeLog.startedAt,
                      form.timeZone,
                    )}
                    {source.data.timeLog.stoppedAt && (
                      <>
                        {" "}
                        · Fin:{" "}
                        {displayInstant(
                          source.data.timeLog.stoppedAt,
                          form.timeZone,
                        )}
                      </>
                    )}{" "}
                    ·{" "}
                    {source.data.timeLog.status === "running"
                      ? "En curso"
                      : formatLogDuration(source.data.timeLog.seconds)}
                    . Para corregir un intervalo cerrado, crea un registro
                    manual y elimina el anterior.
                  </p>
                )}
                <Field label="Notas del registro">
                  <textarea
                    rows={3}
                    maxLength={100000}
                    value={form.description}
                    onChange={(event) =>
                      patch({ description: event.target.value })
                    }
                  />
                </Field>
                <label className="time-check">
                  <input
                    type="checkbox"
                    disabled={!!source}
                    checked={form.shared}
                    onChange={(event) =>
                      patch({ shared: event.target.checked })
                    }
                  />
                  Compartir con quienes puedan consultar su contexto
                </label>
              </fieldset>
              <div className="time-actions">
                {editable && (
                  <button
                    className="primary"
                    disabled={
                      busy || !draft.ready || !dirty || !form.title.trim()
                    }
                  >
                    {!source && form.mode === "timer"
                      ? "Iniciar temporizador"
                      : "Guardar registro"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reset()}
                >
                  Descartar borrador del registro
                </button>
                {source && editable && (
                  <button
                    type="button"
                    onClick={() => void remove()}
                    disabled={busy}
                  >
                    Eliminar registro
                  </button>
                )}
                {source && (
                  <button type="button" onClick={() => close()}>
                    Cerrar registro
                  </button>
                )}
              </div>
              <p role="status">
                {draft.saved
                  ? "Borrador de tiempo guardado en este dispositivo."
                  : dirty
                    ? "Cambios locales pendientes de guardar."
                    : source
                      ? "Registro guardado."
                      : ""}
              </p>
            </form>
          )}
        </section>
      )}
      <details className="time-filter-panel">
        <summary>
          Filtrar registros de tiempo{" "}
          <span>
            {from} — {to}
          </span>
          <span className="time-filter-scope">
            {projectId
              ? byId.get(projectId)?.title || "Proyecto no disponible"
              : "Todos los proyectos"}{" "}
            ·{" "}
            {authorId
              ? names.get(authorId) || "Antiguo miembro"
              : "Todo el equipo"}
          </span>
        </summary>
        <section aria-label="Filtros de tiempo" className="time-filters">
          <Field label="Tiempo desde">
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setLimit(100);
              }}
            />
          </Field>
          <Field label="Tiempo hasta">
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setLimit(100);
              }}
            />
          </Field>
          <Field label="Filtrar tiempo por proyecto">
            <select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setLimit(100);
              }}
            >
              <option value="">Todos los proyectos</option>
              {resources
                .filter(
                  (resource) =>
                    resource.kind === "project" && !resource.deleted_at,
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Autor del registro">
            <select
              value={authorId}
              onChange={(event) => {
                setAuthorId(event.target.value);
                setLimit(100);
              }}
            >
              <option value="">Todo el equipo</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="time-check">
            <input
              type="checkbox"
              checked={descendants}
              onChange={(event) => setDescendants(event.target.checked)}
            />
            Incluir subproyectos
          </label>
          <label className="time-check">
            <input
              type="checkbox"
              checked={archives}
              onChange={(event) => setArchives(event.target.checked)}
            />
            Incluir archivados
          </label>
        </section>
      </details>
      {filtered.error ? (
        <p role="alert">{filtered.error}</p>
      ) : (
        <>
          <div className="time-summary" aria-label="Resumen del tiempo">
            <div>
              <span>Duración registrada</span>
              <strong>{formatLogDuration(summary.seconds)}</strong>
            </div>
            <div>
              <span>Entradas registradas</span>
              <strong>{summary.recorded}</strong>
            </div>
            <div>
              <span>Relojes en el periodo</span>
              <strong>{summary.running}</strong>
            </div>
          </div>
          <p className="muted">
            El total suma las entradas de la fecha elegida, aunque sus
            intervalos se solapen o crucen medianoche. No incluye los relojes
            activos.
          </p>
          <div className="time-actions">
            <h2>Registros del periodo</h2>
            <button onClick={csv} disabled={!summary.recorded}>
              Exportar tiempo CSV
            </button>
          </div>
          <div
            className="time-table"
            role="region"
            aria-label="Registros de tiempo"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Trabajo</th>
                  <th scope="col">Proyecto y tarea</th>
                  <th scope="col">Autor</th>
                  <th scope="col">Duración</th>
                  <th scope="col">Visibilidad</th>
                </tr>
              </thead>
              <tbody>
                {filtered.entries.slice(0, limit).map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.data.timeLog.date}</td>
                    <th scope="row">
                      <button
                        className="text-button"
                        onClick={() => open(entry)}
                      >
                        {entry.title}
                      </button>
                    </th>
                    <td>
                      {entry.data.projectId &&
                      byId.has(entry.data.projectId) ? (
                        <button
                          className="text-button"
                          onClick={() => open(byId.get(entry.data.projectId)!)}
                        >
                          {byId.get(entry.data.projectId)!.title}
                        </button>
                      ) : (
                        <span>Sin proyecto</span>
                      )}
                      {entry.data.targetId && byId.has(entry.data.targetId) && (
                        <button
                          className="text-button"
                          onClick={() => open(byId.get(entry.data.targetId)!)}
                        >
                          {byId.get(entry.data.targetId)!.title}
                        </button>
                      )}
                    </td>
                    <td>{names.get(entry.created_by) || "Antiguo miembro"}</td>
                    <td>
                      {entry.data.timeLog.status === "running"
                        ? "En curso"
                        : formatLogDuration(entry.data.timeLog.seconds)}
                    </td>
                    <td>{entry.data.ownerId ? "Personal" : "Compartido"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.entries.length && (
              <p>No hay registros para estos filtros.</p>
            )}
          </div>
          {filtered.entries.length > limit && (
            <button onClick={() => setLimit((value) => value + 100)}>
              Mostrar 100 registros más
            </button>
          )}
          <div className="time-breakdowns">
            {table(
              "Tiempo por proyecto",
              summary.projects,
              (id) => byId.get(id)?.title || "Sin proyecto",
            )}
            {table(
              "Tiempo por autor",
              summary.authors,
              (id) => names.get(id) || "Antiguo miembro",
            )}
            {table("Tiempo por fecha", summary.days, (id) => id)}
          </div>
        </>
      )}
    </div>
  );
}

function RunningClock({ entry }: { entry: Resource }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [entry.id]);
  const seconds = elapsedLogSeconds(entry.data.timeLog, now);
  return (
    <>
      <span
        className="time-clock"
        aria-label={`Tiempo transcurrido en ${entry.title}`}
      >
        {formatLogDuration(seconds)}
      </span>
      {seconds > MAX_LOG_SECONDS && (
        <span>Revisa este reloj: supera siete días.</span>
      )}
    </>
  );
}

function displayInstant(value: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone,
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(value));
  } catch {
    return "Fecha no disponible";
  }
}
