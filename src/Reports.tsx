import { useEffect, useMemo, useRef, useState } from "react";
import type { Resource, User, Workspace } from "../shared/model";
import { statusLabels, taskStatuses } from "../shared/model";
import {
  dashboardConfigSchema,
  dashboardReferenceScopes,
  defaultDashboard,
  currentAnalytics,
  reportRange,
  widgetLabels,
  dashboardWidgets,
  historyReportSchema,
  reportCSV,
  type DashboardConfig,
  type HistoryReport,
} from "../shared/analytics";
import { api, ApiError, send } from "./api";
import { readUserCache, writeUserCache, removeUserDraft } from "./storage";
import { useDraft } from "./useDraft";
import { Field } from "./components/Primitives";
type Member = { id: string; name: string };
const amount = (n: number | null) =>
  n === null
    ? "—"
    : new Intl.NumberFormat("es", { maximumFractionDigits: 1 }).format(n);
function download(name: string, body: string) {
  const url = URL.createObjectURL(
      new Blob([body], { type: "text/csv;charset=utf-8" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Reports({
  resources,
  members,
  user,
  workspace,
  canEdit,
  focusId,
  choose,
  open,
  create,
  save,
}: {
  resources: Resource[];
  members: Member[];
  user: User;
  workspace: Workspace;
  canEdit: boolean;
  focusId: string | null;
  choose: (r: Resource | null) => void;
  open: (r: Resource) => void;
  create: (
    kind: "dashboard",
    title: string,
    data: Record<string, any>,
  ) => Promise<Resource | undefined>;
  save: (r: Resource) => Promise<Resource | undefined>;
}) {
  const panels = resources.filter(
      (r) => r.kind === "dashboard" && !r.deleted_at && !r.data.archived,
    ),
    source = panels.find((r) => r.id === focusId),
    original = source
      ? dashboardConfigSchema.parse(source.data.dashboardConfig || {})
      : {
          ...defaultDashboard(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
  const [config, setConfig] = useState<DashboardConfig>(original),
    [title, setTitle] = useState(source?.title || "Mi panel de proyectos"),
    [version, setVersion] = useState(source?.version || 0),
    [shared, setShared] = useState(source ? !source.data.ownerId : false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [online, setOnline] = useState(navigator.onLine),
    [history, setHistory] = useState<HistoryReport | null>(null),
    [historyStatus, setHistoryStatus] = useState(""),
    [historyError, setHistoryError] = useState(""),
    [reload, setReload] = useState(0),
    [limit, setLimit] = useState(5);
  const manage =
    canEdit &&
    (!source || source.created_by === user.id || workspace.role === "admin");
  const draft = useDraft(
    user.id,
    `${workspace.id}:dashboard:${focusId || "default"}`,
    { config, title, version, shared },
    dirty,
    (value) => {
      const parsed = dashboardConfigSchema.safeParse(value?.config);
      if (
        !parsed.success ||
        typeof value.title !== "string" ||
        !Number.isInteger(value.version) ||
        typeof value.shared !== "boolean"
      )
        throw new Error("Invalid dashboard draft");
      setConfig(parsed.data);
      setTitle(value.title);
      setVersion(value.version);
      setShared(value.shared);
      setDirty(true);
    },
  );
  useEffect(() => {
    if (source && !dirty) {
      setConfig(dashboardConfigSchema.parse(source.data.dashboardConfig || {}));
      setTitle(source.title);
      setVersion(source.version);
      setShared(!source.data.ownerId);
    }
  }, [source?.version]);
  useEffect(() => {
    const wake = () => setOnline(navigator.onLine);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    return () => {
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
    };
  }, []);
  const query = JSON.stringify({
      ...config,
      projectIds: [...config.projectIds].sort(),
      assigneeIds: [...config.assigneeIds].sort(),
      labels: [...config.labels].sort(),
      widgets: [...dashboardWidgets],
      columns: 2,
    }),
    scope = resources
      .map((r) => `${r.id}:${r.version}:${r.deleted_at || ""}`)
      .sort()
      .join("|"),
    cacheKey = `${workspace.id}:analytics:${query}`,
    sequence = useRef(0);
  const result = useMemo(() => {
    try {
      dashboardConfigSchema.parse(config);
      if (
        config.projectIds.some(
          (id) =>
            !resources.some(
              (r) => r.id === id && r.kind === "project" && !r.deleted_at,
            ),
        )
      )
        throw new Error(
          "Un proyecto del panel no está disponible. Revisa o restablece sus filtros.",
        );
      return {
        current: currentAnalytics(resources, config),
        range: reportRange(config),
        error: "",
      };
    } catch (e) {
      return { current: null, range: null, error: (e as Error).message };
    }
  }, [resources, config]);
  const current = result.current || currentAnalytics([], defaultDashboard());
  const settingsPanel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (result.error && settingsPanel.current)
      settingsPanel.current.open = true;
  }, [result.error]);
  useEffect(() => {
    const generation = ++sequence.current,
      abort = new AbortController();
    setHistory(null);
    setHistoryError("");
    setHistoryStatus("Calculando el historial…");
    if (
      !draft.ready ||
      Boolean(result.error) ||
      !current ||
      (focusId && !source)
    ) {
      setHistoryStatus("");
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          let value: HistoryReport, cachedAt: string;
          if (!navigator.onLine) {
            const cached = await readUserCache(user.id, cacheKey);
            if (!cached || cached.query !== query || cached.scope !== scope)
              throw new Error(
                "Conecta para calcular el historial con estos filtros y datos.",
              );
            value = historyReportSchema.parse(cached.history);
            cachedAt = cached.cachedAt;
            if (generation === sequence.current)
              setHistoryStatus(
                `Copia local del historial · ${new Date(cachedAt).toLocaleString("es")}`,
              );
          } else {
            value = historyReportSchema.parse(
              await api(`/workspaces/${workspace.id}/analytics`, {
                ...send(JSON.parse(query)),
                signal: abort.signal,
              }),
            );
            cachedAt = new Date().toISOString();
            if (generation !== sequence.current) return;
            await writeUserCache(user.id, cacheKey, {
              query,
              scope,
              history: value,
              cachedAt,
            });
            if (generation === sequence.current)
              setHistoryStatus(
                `Historial verificado · ${new Date(cachedAt).toLocaleString("es")}`,
              );
          }
          if (generation === sequence.current) setHistory(value);
        } catch (e) {
          if (abort.signal.aborted || generation !== sequence.current) return;
          if (e instanceof ApiError && [400, 403, 404].includes(e.status))
            await removeUserDraft(user.id, cacheKey);
          setHistoryError((e as Error).message);
          setHistoryStatus("");
        }
      })();
    }, 400);
    return () => {
      clearTimeout(timer);
      abort.abort();
      sequence.current++;
    };
  }, [
    query,
    scope,
    user.id,
    workspace.id,
    draft.ready,
    online,
    reload,
    Boolean(source),
  ]);
  const patch = (value: Partial<DashboardConfig>) => {
    setConfig((old) => ({ ...old, ...value }));
    setDirty(true);
    setLimit(5);
  };
  const reset = async () => {
    await draft.clear();
    setConfig(original);
    setTitle(source?.title || "Mi panel de proyectos");
    setVersion(source?.version || 0);
    setShared(source ? !source.data.ownerId : false);
    setDirty(false);
    setError("");
  };
  const persist = async () => {
    setBusy(true);
    setError("");
    try {
      dashboardReferenceScopes(config, resources);
      const data = {
        ...(source?.data || {}),
        dashboardConfig: dashboardConfigSchema.parse(config),
        ownerId: shared ? undefined : user.id,
      };
      const stored = source
        ? await save({ ...source, title: title.trim(), version, data })
        : await create("dashboard", title.trim(), data);
      if (stored) {
        setVersion(stored.version);
        await draft.clear();
        setDirty(false);
        setNotice(
          "Panel guardado en este dispositivo; la sincronización confirma su versión en el servidor.",
        );
        choose(stored);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const visibleProjects = resources.filter(
    (r) =>
      r.kind === "project" &&
      !r.deleted_at &&
      (config.includeArchived || !r.data.archived),
  );
  if (focusId && !source)
    return (
      <p role="alert">El panel no está disponible con tus permisos actuales.</p>
    );

  const taskById = new Map(resources.map((r) => [r.id, r]));
  const workload = new Map<
    string,
    { name: string; count: number; points: number }
  >();
  for (const task of current.tasks.filter(
    (t) => !["done", "cancelled"].includes(t.data.status),
  )) {
    const member = members.find((m) => m.id === task.data.assigneeId),
      id = member?.id || (task.data.assigneeId ? "missing" : "unassigned"),
      row = workload.get(id) || {
        name:
          member?.name ||
          (task.data.assigneeId ? "Persona no disponible" : "Sin asignar"),
        count: 0,
        points: 0,
      };
    row.count++;
    row.points += task.data.estimate || 0;
    workload.set(id, row);
  }
  const historyUnavailable = history && !history.available;
  const historyMessage = historyUnavailable
    ? "El historial supera el límite de esta consulta. Reduce los proyectos o el intervalo; no se muestran resultados parciales."
    : historyError || historyStatus;
  return (
    <div className="reports-workspace">
      <div className="report-controls">
        <Field label="Panel guardado">
          <select
            value={focusId || ""}
            onChange={(e) =>
              choose(panels.find((p) => p.id === e.target.value) || null)
            }
          >
            <option value="">Informe del espacio</option>
            {panels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {p.data.ownerId ? "personal" : "compartido"}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          disabled={!online}
        >
          Actualizar historial
        </button>
        <button
          type="button"
          disabled={Boolean(result.error)}
          onClick={() =>
            download(
              "kelvin-cartera.csv",
              reportCSV([
                [
                  "Proyecto",
                  "Tareas vigentes",
                  "Completadas",
                  "Pendientes",
                  "Puntos",
                  "Puntos completados",
                  "Vencidas",
                  "Bloqueadas",
                ],
                ...current.portfolio.map((p) => [
                  p.title,
                  p.total,
                  p.done,
                  p.open,
                  p.points,
                  p.completedPoints,
                  p.overdue,
                  p.blocked,
                ]),
              ]),
            )
          }
        >
          Exportar cartera CSV
        </button>
        {source && (
          <button
            type="button"
            onClick={() =>
              navigator.clipboard
                .writeText(
                  new URL(`/?resource=${source.id}`, location.origin).href,
                )
                .then(() => setNotice("Enlace del panel copiado."))
                .catch(() =>
                  setNotice(
                    new URL(`/?resource=${source.id}`, location.origin).href,
                  ),
                )
            }
          >
            Copiar enlace del panel
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {draft.issue && <p role="alert">{draft.issue}</p>}
      {result.error && <p role="alert">{result.error}</p>}
      <details className="report-settings" ref={settingsPanel}>
        <summary>Personalizar panel y filtros</summary>
        <div className="report-settings-grid">
          <Field label="Nombre del panel">
            <input
              value={title}
              maxLength={500}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
            />
          </Field>
          <Field label="Proyectos del panel">
            <select
              multiple
              value={config.projectIds}
              onChange={(e) =>
                patch({
                  projectIds: [...e.target.selectedOptions].map((o) => o.value),
                })
              }
            >
              {visibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Responsables del panel">
            <select
              multiple
              value={config.assigneeIds}
              onChange={(e) =>
                patch({
                  assigneeIds: [...e.target.selectedOptions].map(
                    (o) => o.value,
                  ),
                })
              }
            >
              <option value="unassigned">Sin asignar</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Etiquetas del panel">
            <input
              key={config.labels.join(",")}
              defaultValue={config.labels.join(", ")}
              placeholder="Separadas por comas"
              onBlur={(e) =>
                patch({
                  labels: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="Ventana del historial">
            <select
              value={config.rangeDays}
              onChange={(e) =>
                patch({
                  rangeDays: Number(e.target.value) as 7 | 30 | 90 | 365,
                  from: "",
                  to: "",
                })
              }
            >
              {[7, 30, 90, 365].map((n) => (
                <option key={n} value={n}>
                  Últimos {n} días
                </option>
              ))}
            </select>
          </Field>
          <Field label="Historial desde">
            <input
              type="date"
              value={config.from}
              onChange={(e) => patch({ from: e.target.value })}
            />
          </Field>
          <Field label="Historial hasta">
            <input
              type="date"
              value={config.to}
              onChange={(e) => patch({ to: e.target.value })}
            />
          </Field>
          <Field label="Zona horaria del panel">
            <input
              value={config.timeZone}
              onChange={(e) => patch({ timeZone: e.target.value })}
            />
          </Field>
          <Field label="Columnas del panel">
            <select
              value={config.columns}
              onChange={(e) =>
                patch({ columns: Number(e.target.value) as 1 | 2 })
              }
            >
              <option value="1">Una columna</option>
              <option value="2">Dos columnas</option>
            </select>
          </Field>
        </div>
        <div className="report-checks">
          <label>
            <input
              type="checkbox"
              checked={config.includeDescendants}
              onChange={(e) => patch({ includeDescendants: e.target.checked })}
            />
            Incluir subproyectos de la selección
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.includeArchived}
              onChange={(e) => patch({ includeArchived: e.target.checked })}
            />
            Incluir proyectos y tareas archivados
          </label>
          <label>
            <input
              type="checkbox"
              checked={shared}
              disabled={Boolean(source && source.created_by !== user.id)}
              onChange={(e) => {
                setShared(e.target.checked);
                setDirty(true);
              }}
            />
            Compartir con quienes puedan consultar los proyectos seleccionados
          </label>
        </div>
        <fieldset className="report-widget-choices">
          <legend>Secciones y orden</legend>
          {dashboardWidgets.map((widget) => {
            const index = config.widgets.indexOf(widget);
            return (
              <div key={widget}>
                <label>
                  <input
                    type="checkbox"
                    checked={index >= 0}
                    disabled={index >= 0 && config.widgets.length === 1}
                    onChange={(e) =>
                      patch({
                        widgets: e.target.checked
                          ? [...config.widgets, widget]
                          : config.widgets.filter((w) => w !== widget),
                      })
                    }
                  />
                  {widgetLabels[widget]}
                </label>
                {index >= 0 && (
                  <>
                    <button
                      type="button"
                      aria-label={`Subir ${widgetLabels[widget]}`}
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...config.widgets];
                        [next[index - 1], next[index]] = [
                          next[index],
                          next[index - 1],
                        ];
                        patch({ widgets: next });
                      }}
                    >
                      Subir
                    </button>
                    <button
                      type="button"
                      aria-label={`Bajar ${widgetLabels[widget]}`}
                      disabled={index === config.widgets.length - 1}
                      onClick={() => {
                        const next = [...config.widgets];
                        [next[index + 1], next[index]] = [
                          next[index],
                          next[index + 1],
                        ];
                        patch({ widgets: next });
                      }}
                    >
                      Bajar
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </fieldset>
        <div className="report-controls">
          <button type="button" onClick={() => void reset()}>
            Restaurar configuración guardada
          </button>
          {manage && (
            <button
              className="primary"
              type="button"
              disabled={
                busy || !draft.ready || !title.trim() || Boolean(result.error)
              }
              onClick={() => void persist()}
            >
              {source ? "Guardar panel" : "Guardar como panel"}
            </button>
          )}
          {source && manage && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!confirm("¿Eliminar este panel y su borrador local?"))
                  return;
                try {
                  await save({
                    ...source,
                    version,
                    deleted_at: new Date().toISOString(),
                  });
                  await draft.clear();
                  choose(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Eliminar panel
            </button>
          )}
          <span role="status">
            {draft.saved
              ? "Borrador del panel guardado en este dispositivo."
              : dirty
                ? "Configuración local sin guardar."
                : "Configuración guardada."}
          </span>
        </div>
        {!manage && (
          <p className="muted">
            Puedes explorar los filtros de este panel. Su autor o la
            administración puede guardar la configuración compartida.
          </p>
        )}
        {source && version !== source.version && (
          <p className="notice warning">
            El panel ha cambiado en el servidor. Tu borrador conserva su versión
            y se revisará antes de sobrescribirla.
          </p>
        )}
      </details>
      {!result.error && (
        <p className="muted">
          {current.summary.overdue > 0 && (
            <strong className="report-overdue">
              {current.summary.overdue}{" "}
              {current.summary.overdue === 1
                ? "tarea vencida"
                : "tareas vencidas"}{" "}
              en el alcance visible.{" "}
            </strong>
          )}
          Datos actuales de {current.tasks.length} tareas autorizadas. Cada
          tarea se cuenta una vez; los proyectos muestran su trabajo directo. El
          intervalo {result.range?.from} — {result.range?.to} limita el
          historial.
        </p>
      )}
      {!result.error && (
        <div className="report-widget-grid" data-columns={config.columns}>
          {config.widgets.map((widget) => (
            <section
              className={`report-widget report-${widget}`}
              key={widget}
              aria-label={widgetLabels[widget]}
            >
              <h2>{widgetLabels[widget]}</h2>
              {widget === "summary" && (
                <div className="report-summary">
                  <div>
                    <span>Tareas completadas</span>
                    <strong>
                      {current.summary.done}
                      <small> / {current.summary.total}</small>
                    </strong>
                  </div>
                  <div>
                    <span>Pendientes</span>
                    <strong>{current.summary.open}</strong>
                  </div>
                  <div>
                    <span>Puntos completados</span>
                    <strong>
                      {amount(current.summary.completedPoints)}
                      <small> / {amount(current.summary.points)}</small>
                    </strong>
                  </div>
                </div>
              )}
              {widget === "portfolio" && (
                <>
                  <div
                    className="report-table-scroll"
                    role="region"
                    tabIndex={0}
                    aria-label="Tabla de cartera"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Proyecto</th>
                          <th>Completadas / vigentes</th>
                          <th>Puntos completados / alcance</th>
                          <th>Vencidas</th>
                          <th>Bloqueadas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {current.portfolio.slice(0, limit).map((p) => (
                          <tr key={p.id || "none"}>
                            <th>
                              {p.id ? (
                                <button
                                  className="text-button"
                                  onClick={() => open(taskById.get(p.id!)!)}
                                >
                                  {p.title}
                                </button>
                              ) : (
                                p.title
                              )}
                            </th>
                            <td>
                              {p.done} / {p.total}
                            </td>
                            <td>
                              {amount(p.completedPoints)} / {amount(p.points)}
                            </td>
                            <td
                              className={
                                p.overdue ? "report-overdue" : undefined
                              }
                            >
                              {p.overdue}
                            </td>
                            <td>{p.blocked}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="report-table-hint muted">
                    Desliza la tabla para ver todas las columnas.
                  </p>
                  {!current.portfolio.length && (
                    <p>Los proyectos con acceso aparecerán en esta cartera.</p>
                  )}
                  {current.portfolio.length > limit && (
                    <button onClick={() => setLimit((n) => n + 20)}>
                      Mostrar más proyectos ({current.portfolio.length})
                    </button>
                  )}
                </>
              )}
              {widget === "status" && (
                <>
                  {taskStatuses.map((status) => {
                    const count = current.tasks.filter(
                      (t) => t.data.status === status,
                    ).length;
                    return (
                      <div className="report-bar" key={status}>
                        <span>{statusLabels[status]}</span>
                        <div aria-hidden="true">
                          <span
                            style={{
                              width: `${current.tasks.length ? (count / current.tasks.length) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <strong>{count}</strong>
                      </div>
                    );
                  })}
                  {current.tasks.some(
                    (t) => !taskStatuses.includes(t.data.status),
                  ) && (
                    <div className="report-bar">
                      <span>Sin estado reconocido</span>
                      <div aria-hidden="true">
                        <span
                          style={{
                            width: `${(current.tasks.filter((t) => !taskStatuses.includes(t.data.status)).length / current.tasks.length) * 100}%`,
                          }}
                        />
                      </div>
                      <strong>
                        {
                          current.tasks.filter(
                            (t) => !taskStatuses.includes(t.data.status),
                          ).length
                        }
                      </strong>
                    </div>
                  )}
                  <p className="muted">
                    El reparto incluye las tareas canceladas; el resumen las
                    excluye del alcance vigente.
                  </p>
                </>
              )}
              {widget === "workload" && (
                <>
                  {[...workload.entries()]
                    .sort((a, b) => b[1].count - a[1].count)
                    .slice(0, limit)
                    .map(([id, row]) => (
                      <div className="member-workload" key={id}>
                        <span>{row.name}</span>
                        <strong>{row.count} tareas</strong>
                        <span>{amount(row.points)} puntos</span>
                      </div>
                    ))}
                  {!workload.size && (
                    <p>No hay tareas pendientes con estos filtros.</p>
                  )}
                  {workload.size > limit && (
                    <button onClick={() => setLimit((n) => n + 20)}>
                      Mostrar toda la carga
                    </button>
                  )}
                </>
              )}
              {widget === "attention" && (
                <>
                  {current.attention.slice(0, limit).map((t) => (
                    <div className="report-attention" key={t.id}>
                      <button onClick={() => open(taskById.get(t.id)!)}>
                        {t.title}
                      </button>
                      <span>
                        {t.overdue ? "Vencida" : ""}
                        {t.overdue && t.blocked ? " · " : ""}
                        {t.blocked
                          ? "Dependencia pendiente o no disponible"
                          : ""}
                      </span>
                    </div>
                  ))}
                  {!current.attention.length && (
                    <p>
                      No hay vencimientos ni dependencias pendientes en las
                      tareas visibles.
                    </p>
                  )}
                  {current.attention.length > limit && (
                    <button onClick={() => setLimit((n) => n + 20)}>
                      Mostrar todas las tareas con atención (
                      {current.attention.length})
                    </button>
                  )}
                </>
              )}
              {widget === "delivery_history" &&
                (history?.available ? (
                  <>
                    <div className="report-history-stats">
                      <span>
                        <strong>{history.completionEvents}</strong> entregas
                        verificadas
                      </span>
                      <span>
                        <strong>{history.deliveredTasks}</strong> tareas
                        entregadas
                      </span>
                      <span>
                        <strong>{history.reopenedEvents}</strong> reaperturas
                      </span>
                      <span>
                        <strong>{amount(history.medianLeadHours)}</strong> h de
                        creación a entrega · mediana de{" "}
                        {history.leadMeasurements} mediciones
                      </span>
                      <span>
                        <strong>{amount(history.medianCycleHours)}</strong> h de
                        trabajo a entrega · mediana de{" "}
                        {history.cycleMeasurements} mediciones
                      </span>
                    </div>
                    <DeliveryChart daily={history.daily} />
                    <details>
                      <summary>Datos del gráfico de entregas</summary>
                      <div className="report-table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Día</th>
                              <th>Entregas</th>
                              <th>Reaperturas</th>
                            </tr>
                          </thead>
                          <tbody>
                            {history.daily.map((d) => (
                              <tr key={d.day}>
                                <th>{d.day}</th>
                                <td>{d.completed}</td>
                                <td>{d.reopened}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                    <button
                      onClick={() =>
                        download(
                          "kelvin-entregas.csv",
                          reportCSV([
                            ["Día", "Entregas verificadas", "Reaperturas"],
                            ...history.daily.map((d) => [
                              d.day,
                              d.completed,
                              d.reopened,
                            ]),
                          ]),
                        )
                      }
                    >
                      Exportar historial CSV
                    </button>
                    <p className="muted">
                      {historyStatus}. Transiciones con origen y destino
                      autorizados; las duraciones requieren un recorrido
                      verificable. Una tarea reabierta puede tener varias
                      entregas.
                    </p>
                  </>
                ) : (
                  <p role={historyError ? "alert" : "status"}>
                    {historyMessage}
                  </p>
                ))}
              {widget === "sprint_history" &&
                (history?.available ? (
                  <>
                    {history.closedSprints.slice(0, limit).map((s) => (
                      <div className="report-sprint" key={s.id}>
                        <button
                          onClick={() => {
                            const r = taskById.get(s.id);
                            if (r) open(r);
                          }}
                        >
                          {s.title}
                        </button>
                        <span>
                          {s.closedAt.slice(0, 10)} · {s.done}/{s.total} tareas
                          · {amount(s.completedPoints)}/{amount(s.points)}{" "}
                          puntos
                        </span>
                      </div>
                    ))}
                    {!history.closedSprints.length && (
                      <p>
                        No hay cierres con tareas autorizadas en este intervalo.
                      </p>
                    )}
                    {history.closedSprints.length > limit && (
                      <button onClick={() => setLimit((n) => n + 20)}>
                        Mostrar más sprints ({history.closedSprints.length})
                      </button>
                    )}
                    {history.sprintRowsLimited && (
                      <p>
                        Se muestran los 100 cierres más recientes del intervalo.
                      </p>
                    )}
                    <p className="muted">
                      Alcance del cierre filtrado por las tareas actuales y sus
                      permisos históricos.
                    </p>
                  </>
                ) : (
                  <p role={historyError ? "alert" : "status"}>
                    {historyMessage}
                  </p>
                ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
function DeliveryChart({
  daily,
}: {
  daily: Array<{ day: string; completed: number }>;
}) {
  const maximum = Math.max(
      2,
      Math.ceil(Math.max(0, ...daily.map((d) => d.completed)) / 2) * 2,
    ),
    points = daily
      .map(
        (d, i) =>
          `${36 + (i * 540) / Math.max(1, daily.length - 1)},${150 - (d.completed / maximum) * 120}`,
      )
      .join(" ");
  return (
    <svg
      className="delivery-chart"
      role="img"
      aria-label={`Entregas verificadas por día, del ${daily[0]?.day} al ${daily.at(-1)?.day}`}
      viewBox="0 0 600 185"
    >
      {[0, 0.5, 1].map((ratio) => (
        <g key={ratio}>
          <line
            x1="36"
            x2="576"
            y1={150 - ratio * 120}
            y2={150 - ratio * 120}
          />
          <text x="28" y={154 - ratio * 120} textAnchor="end">
            {amount(maximum * ratio)}
          </text>
        </g>
      ))}
      <polyline points={points} />
      <text x="36" y="178">
        {daily[0]?.day}
      </text>
      <text x="576" y="178" textAnchor="end">
        {daily.at(-1)?.day}
      </text>
    </svg>
  );
}
