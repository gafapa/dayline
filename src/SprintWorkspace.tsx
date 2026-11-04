import { stateLabel } from "../shared/workflow";
import { ConfiguredTaskFields } from "./CustomFieldInputs";
import {
  fieldDefaults,
  customFieldValueSchema,
  type CustomFieldValue,
} from "../shared/custom-fields";
import { useCallback, useEffect, useRef, useState, useId } from "react";
import { ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import { api, send } from "./api";
import { Field } from "./components/Primitives";
import { flushOutbox, readUserDraft, writeUserDraft } from "./storage";
import { useSprintDraft } from "./useSprintDraft";
import {
  capacityHours,
  emptyCeremony,
  pokerDeck,
  completionWarnings,
  ceremonySchema,
  type CapacityEntry,
  type Ceremony,
} from "../shared/sprints";
import { statusLabels, type Resource, type User } from "../shared/model";

type Props = {
  workspaceId: string;
  resources: Resource[];
  members: any[];
  user: User;
  open: (resource: Resource) => void;
  create: (kind: any, title: string, data: any) => Promise<any>;
  newSprint: () => void;
  save: (resource: Resource) => Promise<any>;
  refresh: () => Promise<any>;
};
export default function SprintWorkspace(props: Props) {
  const sprints = props.resources.filter(
      (r) => r.kind === "sprint" && !r.deleted_at,
    ),
    [selected, setSelected] = useState(
      sprints.find((s) => s.data.status === "active")?.id ||
        sprints[0]?.id ||
        "",
    );
  useEffect(() => {
    if (!sprints.some((s) => s.id === selected))
      setSelected(
        sprints.find((s) => s.data.status === "active")?.id ||
          sprints[0]?.id ||
          "",
      );
  }, [selected, sprints.map((s) => s.id).join(",")]);
  if (!sprints.length)
    return (
      <div className="inline-empty">
        <p>Define un objetivo y prepara el primer sprint.</p>
        <button onClick={props.newSprint}>Crear sprint</button>
      </div>
    );
  return (
    <div className="sprint-workspace">
      <Field label="Sprint de trabajo">
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {sprints.map((sprint) => (
            <option key={sprint.id} value={sprint.id}>
              {sprint.title} ·{" "}
              {statusLabels[sprint.data.status] || "Planificado"}
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <SprintDetail
          key={selected}
          {...props}
          sprintId={selected}
          sprints={sprints}
        />
      )}
    </div>
  );
}
function SprintDetail(
  props: Props & { sprintId: string; sprints: Resource[] },
) {
  const { workspaceId, sprintId, user } = props,
    base = `/workspaces/${workspaceId}/sprints/${sprintId}`;
  const [plan, setPlan] = useState<any>(null),
    [tab, setTab] = useState("plan"),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshingPlan, setRefreshingPlan] = useState(true),
    [online, setOnline] = useState(navigator.onLine),
    [closeTarget, setCloseTarget] = useState(""),
    [acknowledge, setAcknowledge] = useState(false),
    [showClose, setShowClose] = useState(false),
    [hasPlanDraft, setHasPlanDraft] = useState(true);
  const planRead = useRef(0);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const load = useCallback(async () => {
    const generation = ++planRead.current;
    setRefreshingPlan(true);
    setShowClose(false);
    try {
      const result = await api(`${base}/planning`);
      if (generation !== planRead.current) return;
      setPlan((previous: any) => ({
        ...result,
        clientRevision: (previous?.clientRevision || 0) + 1,
      }));
      setError("");
      void writeUserDraft(
        user.id,
        `${workspaceId}:${sprintId}:planning-cache`,
        { ...result, candidates: [], cachedAt: new Date().toISOString() },
      ).catch(() =>
        setMessage(
          "El plan está disponible en línea, pero no se ha podido actualizar su copia local.",
        ),
      );
    } catch (error) {
      if (generation !== planRead.current) return;
      if (!navigator.onLine) {
        try {
          const cached = await readUserDraft(
            user.id,
            `${workspaceId}:${sprintId}:planning-cache`,
          );
          if (generation !== planRead.current) return;
          if (cached?.sprint?.id === sprintId && Array.isArray(cached.tasks)) {
            setPlan((previous: any) => ({
              ...cached,
              clientRevision: (previous?.clientRevision || 0) + 1,
              candidates: props.resources.filter(
                (resource) =>
                  resource.kind === "task" &&
                  !resource.deleted_at &&
                  !["done", "cancelled"].includes(resource.data.status) &&
                  (!resource.data.sprintId ||
                    resource.data.sprintId === sprintId ||
                    props.resources.some(
                      (sprint) =>
                        sprint.id === resource.data.sprintId &&
                        sprint.data.status === "planned",
                    )),
              ),
            }));
            setMessage(
              `Copia local del plan: ${new Date(cached.cachedAt).toLocaleString("es")}.`,
            );
            setError("");
            return;
          }
        } catch {}
      }
      setError((error as Error).message);
    } finally {
      if (generation === planRead.current) setRefreshingPlan(false);
    }
  }, [base, user.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const execute = async (work: () => Promise<any>, success: string) => {
    setBusy(true);
    setError("");
    try {
      await flushOutbox(user.id, workspaceId, () => {});
      await work();
      await props.refresh();
      await load();
      setMessage(success);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!plan)
    return (
      <div>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p role="status">Cargando el plan del sprint…</p>
        )}
        <button onClick={() => void load()}>Actualizar datos</button>
      </div>
    );
  const sprint = plan.sprint as Resource,
    closed = sprint.data.status === "completed",
    warnings = completionWarnings(sprint, plan.tasks),
    canManage = plan.canEdit;
  return (
    <section className="sprint-detail">
      <header className="sprint-detail-header">
        <div>
          <span className={`status-pill ${sprint.data.status}`}>
            {statusLabels[sprint.data.status]}
          </span>
          <h2>
            <button className="text-button" onClick={() => props.open(sprint)}>
              {sprint.title}
            </button>
          </h2>
          <p>
            {sprint.data.goal ||
              "Añade el objetivo desde los detalles del sprint."}
          </p>
        </div>
        <button onClick={() => void load()} disabled={busy || refreshingPlan}>
          Actualizar datos
        </button>
      </header>
      {!online && (
        <p role="status" className="notice warning">
          La planificación compartida y las estimaciones necesitan conexión. Los
          cambios de tareas siguen disponibles en sus vistas habituales.
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <nav className="sprint-tabs" aria-label="Áreas del sprint">
        {[
          ["plan", "Planificación"],
          ["poker", "Estimación compartida"],
          ["review", "Revisión y retrospectiva"],
          ["metrics", "Métricas"],
        ].map(([value, label]) => (
          <button
            key={value}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "plan" && (
        <SprintPlan
          key={`${sprint.id}-${sprint.version}-${plan.clientRevision}`}
          plan={plan}
          members={props.members}
          projects={props.resources}
          base={base}
          user={user}
          workspaceId={workspaceId}
          online={online}
          saved={async () => {
            await props.refresh();
            await load();
          }}
          open={props.open}
          draftChanged={setHasPlanDraft}
        />
      )}
      {tab === "poker" && (
        <SprintPoker
          base={base}
          plan={plan}
          members={props.members}
          online={online}
          refreshPlan={load}
          canVote={true}
        />
      )}
      {tab === "review" && (
        <SprintReview
          base={base}
          resources={props.resources}
          members={props.members}
          user={user}
          workspaceId={workspaceId}
          create={props.create}
          canEdit={plan.canReview}
          sprint={sprint}
          online={online}
        />
      )}
      {tab === "metrics" && (
        <SprintMetrics
          base={base}
          open={props.open}
          resources={props.resources}
        />
      )}
      {canManage && (
        <div className="sprint-lifecycle">
          {sprint.data.status === "planned" && (
            <button
              disabled={busy || !online || hasPlanDraft}
              onClick={() =>
                void execute(
                  () =>
                    api(
                      `${base}/start`,
                      send({
                        operationId: crypto.randomUUID(),
                        expectedVersion: sprint.version,
                      }),
                    ),
                  "Sprint iniciado; su alcance inicial se conserva.",
                )
              }
            >
              Iniciar sprint
            </button>
          )}
          <button
            disabled={busy || refreshingPlan || !online || hasPlanDraft}
            onClick={() => setShowClose((value) => !value)}
          >
            Preparar cierre
          </button>
          {showClose && (
            <div className="sprint-close-form">
              <h3>Cerrar el sprint</h3>
              <p>
                Se conservará una fotografía de {plan.tasks.length} tareas. Las
                rondas de estimación abiertas se cancelarán.
              </p>
              <Field label="Destino de las tareas pendientes">
                <select
                  value={closeTarget}
                  onChange={(event) => setCloseTarget(event.target.value)}
                >
                  <option value="">Backlog sin sprint</option>
                  {props.sprints
                    .filter(
                      (s) =>
                        s.id !== sprint.id && s.data.status !== "completed",
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
              </Field>
              {!!(warnings.sprintCriteria || warnings.taskChecklists) && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                  />
                  Confirmo el cierre con {warnings.sprintCriteria} criterios y{" "}
                  {warnings.taskChecklists} listas de tareas pendientes.
                </label>
              )}
              <button
                disabled={
                  busy ||
                  !online ||
                  (!!(warnings.sprintCriteria || warnings.taskChecklists) &&
                    !acknowledge)
                }
                onClick={() =>
                  void execute(
                    () =>
                      api(
                        `${base}/close`,
                        send({
                          expectedVersion: sprint.version,
                          rolloverSprintId: closeTarget || null,
                          acknowledgeIncomplete: acknowledge,
                          expectedTasks: plan.tasks.map((task: Resource) => ({
                            id: task.id,
                            version: task.version,
                          })),
                        }),
                      ),
                    "Sprint cerrado. Su alcance y sus estimaciones quedan conservados.",
                  )
                }
              >
                Confirmar cierre del sprint
              </button>
            </div>
          )}
        </div>
      )}
      {canManage && hasPlanDraft && (
        <p role="status">
          Guarda o descarta el borrador de planificación antes de iniciar o
          cerrar el sprint.
        </p>
      )}
      <p className="muted">
        Los datos y los recuentos respetan tus permisos actuales. Horas y puntos
        se muestran como unidades distintas.
      </p>
    </section>
  );
}
function SprintPlan({
  plan,
  members,
  projects = [],
  base,
  user,
  workspaceId,
  online,
  saved,
  open,
  draftChanged,
}: any) {
  const sprint = plan.sprint as Resource,
    closed = sprint.data.status === "completed";
  const sorted = [...plan.tasks].sort(
    (a: Resource, b: Resource) =>
      (a.data.order ?? Number.MAX_SAFE_INTEGER) -
      (b.data.order ?? Number.MAX_SAFE_INTEGER),
  );
  const [selected, setSelected] = useState<string[]>(
      sorted.map((task: Resource) => task.id),
    ),
    [capacity, setCapacity] = useState<CapacityEntry[]>(
      sprint.data.capacityPlan || [],
    ),
    [definition, setDefinition] = useState(sprint.data.definitionOfDone || ""),
    [checklist, setChecklist] = useState<any[]>(sprint.data.checklist || []),
    [criterion, setCriterion] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [baseVersion, setBaseVersion] = useState(sprint.version);
  const versions = useRef(
      new Map<string, number>(
        plan.tasks.map((task: Resource) => [task.id, task.version]),
      ),
    ),
    tasks = new Map<string, Resource>(
      [...plan.candidates, ...plan.tasks].map((task: Resource) => [
        task.id,
        task,
      ]),
    ),
    chosen = selected.map((id) => tasks.get(id)).filter(Boolean) as Resource[];
  const draftStore = useSprintDraft(
    user.id,
    `${workspaceId}:${sprint.id}:plan`,
    {
      selected,
      capacity,
      definition,
      checklist,
      baseVersion,
      taskVersions: [...versions.current],
    },
    dirty,
    (value) => {
      if (
        !Array.isArray(value.capacity) ||
        value.capacity.some(
          (entry: any) =>
            typeof entry.userId !== "string" ||
            ["days", "hoursPerDay", "focusPercent"].some(
              (key) =>
                typeof entry[key] !== "number" || !Number.isFinite(entry[key]),
            ) ||
            (entry.points !== null &&
              (typeof entry.points !== "number" ||
                !Number.isFinite(entry.points))),
        )
      )
        throw new Error("Invalid local capacity draft");
      const restoredCapacity = value.capacity as CapacityEntry[];
      if (
        !Array.isArray(value.selected) ||
        value.selected.some((id: any) => typeof id !== "string") ||
        typeof value.definition !== "string" ||
        !Number.isInteger(value.baseVersion) ||
        !Array.isArray(value.checklist) ||
        value.checklist.some(
          (entry: any) =>
            typeof entry.text !== "string" ||
            typeof entry.id !== "string" ||
            typeof entry.done !== "boolean",
        ) ||
        !Array.isArray(value.taskVersions) ||
        value.taskVersions.some(
          (entry: any) =>
            !Array.isArray(entry) ||
            typeof entry[0] !== "string" ||
            !Number.isInteger(entry[1]),
        )
      )
        throw new Error("Invalid local sprint draft");
      versions.current = new Map(value.taskVersions);
      setSelected(value.selected);
      setCapacity(restoredCapacity);
      setDefinition(value.definition);
      setChecklist(value.checklist);
      setBaseVersion(value.baseVersion);
      setDirty(true);
    },
    plan.canEdit,
  );
  useEffect(
    () => draftChanged(!draftStore.ready || dirty || busy),
    [dirty, busy, draftStore.ready, draftChanged],
  );
  const updateCapacity = (id: string, patch: any) => {
    setCapacity((current) =>
      current.map((entry) =>
        entry.userId === id ? { ...entry, ...patch } : entry,
      ),
    );
    setDirty(true);
  };
  const move = (index: number, direction: number) => {
    const next = [...selected],
      target = index + direction;
    [next[index], next[target]] = [next[target], next[index]];
    setSelected(next);
    setDirty(true);
  };
  return (
    <>
      <div className="sprint-draft-status">
        {draftStore.issue && <p role="alert">{draftStore.issue}</p>}
        {dirty && (
          <p role="status">
            {draftStore.saved
              ? "Borrador guardado en este dispositivo."
              : "Guardando borrador local…"}
          </p>
        )}
        {baseVersion !== sprint.version && (
          <p role="alert">
            El sprint cambió desde que empezaste este borrador. Se conserva su
            versión original para evitar sobrescribir el trabajo del equipo.
          </p>
        )}
        {(dirty || draftStore.issue) && (
          <button
            onClick={async () => {
              if (
                !confirm(
                  "¿Descartar este borrador local y volver a los datos cargados del servidor?",
                )
              )
                return;
              await draftStore.clear();
              setSelected(sorted.map((task: Resource) => task.id));
              setCapacity(sprint.data.capacityPlan || []);
              setDefinition(sprint.data.definitionOfDone || "");
              setChecklist(sprint.data.checklist || []);
              setBaseVersion(sprint.version);
              versions.current = new Map(
                plan.tasks.map((task: Resource) => [task.id, task.version]),
              );
              setDirty(false);
            }}
          >
            Descartar borrador de planificación
          </button>
        )}
      </div>
      <fieldset
        className="sprint-plan sprint-form"
        aria-label="Planificación del sprint"
        disabled={busy || !draftStore.ready}
      >
        <div className="section-heading">
          <h3>
            {closed
              ? "Alcance conservado al cierre"
              : "Alcance y orden de trabajo"}
          </h3>
          <span>
            {chosen.length} tareas ·{" "}
            {chosen.reduce((sum, task) => sum + (task.data.estimate || 0), 0)}{" "}
            puntos
          </span>
        </div>
        {selected.map((id, index) => {
          const task = tasks.get(id);
          return (
            task && (
              <div className="sprint-plan-task" key={id}>
                <div>
                  <button className="text-button" onClick={() => open(task)}>
                    {task.title}
                  </button>
                  <small>
                    {stateLabel(task, projects)} · {task.data.estimate || 0}{" "}
                    puntos
                  </small>
                </div>
                {plan.canEdit && (
                  <div className="sprint-task-controls">
                    <button
                      disabled={index === 0}
                      aria-label={`Subir ${task.title}`}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      disabled={index === selected.length - 1}
                      aria-label={`Bajar ${task.title}`}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      aria-label={`Sacar ${task.title} del sprint`}
                      onClick={() => {
                        setSelected((current) =>
                          current.filter((taskId) => taskId !== id),
                        );
                        setDirty(true);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
            )
          );
        })}
        {plan.canEdit && (
          <Field label="Añadir tarea al sprint">
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  const task = tasks.get(event.target.value);
                  if (task) versions.current.set(task.id, task.version);
                  setSelected((current) => [...current, event.target.value]);
                  setDirty(true);
                }
              }}
            >
              <option value="">Selecciona trabajo pendiente</option>
              {plan.candidates
                .filter((task: Resource) => !selected.includes(task.id))
                .map((task: Resource) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                    {task.data.sprintId ? " · otro sprint planificado" : ""}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <h3>Capacidad del equipo</h3>
        <p className="muted">
          Las horas disponibles se calculan con días, horas por día y porcentaje
          de dedicación. La capacidad en puntos se introduce por separado;
          dejarla vacía significa sin definir.
        </p>
        {!capacity.length && <p>Sin capacidad configurada para este sprint.</p>}
        {capacity.map((entry) => {
          const member = members.find((m: any) => m.id === entry.userId),
            load = chosen
              .filter((task) => task.data.assigneeId === entry.userId)
              .reduce((sum, task) => sum + (task.data.estimate || 0), 0);
          return (
            <fieldset className="capacity-card" key={entry.userId}>
              <legend>{member?.name || "Miembro anterior"}</legend>
              <div className="capacity-fields">
                <Field
                  label={`Días disponibles de ${member?.name || entry.userId}`}
                >
                  <input
                    type="number"
                    min="0"
                    max="366"
                    step="0.5"
                    value={entry.days}
                    readOnly={!plan.canEdit}
                    onChange={(event) =>
                      updateCapacity(entry.userId, {
                        days: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label={`Horas por día de ${member?.name || entry.userId}`}
                >
                  <input
                    type="number"
                    min="0"
                    max="24"
                    step="0.5"
                    value={entry.hoursPerDay}
                    readOnly={!plan.canEdit}
                    onChange={(event) =>
                      updateCapacity(entry.userId, {
                        hoursPerDay: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label={`Dedicación de ${member?.name || entry.userId} (%)`}
                >
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={entry.focusPercent}
                    readOnly={!plan.canEdit}
                    onChange={(event) =>
                      updateCapacity(entry.userId, {
                        focusPercent: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label={`Capacidad en puntos de ${member?.name || entry.userId}`}
                >
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="0.5"
                    value={entry.points ?? ""}
                    readOnly={!plan.canEdit}
                    onChange={(event) =>
                      updateCapacity(entry.userId, {
                        points:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <p>
                {capacityHours(entry)} horas disponibles · {load} puntos
                asignados
                {entry.points !== null ? ` de ${entry.points}` : ""}
              </p>
              {entry.points !== null && load > entry.points && (
                <p role="status" className="notice warning">
                  La carga supera la capacidad indicada en puntos.
                </p>
              )}
              {plan.canEdit && (
                <button
                  className="text-button"
                  onClick={() => {
                    setCapacity((current) =>
                      current.filter((c) => c.userId !== entry.userId),
                    );
                    setDirty(true);
                  }}
                >
                  Quitar capacidad de {member?.name || "esta persona"}
                </button>
              )}
            </fieldset>
          );
        })}
        {plan.canEdit && (
          <Field label="Añadir capacidad de una persona">
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  setCapacity((current) => [
                    ...current,
                    {
                      userId: event.target.value,
                      days: 0,
                      hoursPerDay: 6,
                      focusPercent: 100,
                      points: null,
                    },
                  ]);
                  setDirty(true);
                }
              }}
            >
              <option value="">Selecciona una persona</option>
              {members
                .filter(
                  (member: any) =>
                    !capacity.some((entry) => entry.userId === member.id),
                )
                .map((member: any) => (
                  <option value={member.id} key={member.id}>
                    {member.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Definición de terminado del sprint">
          <textarea
            rows={3}
            value={definition}
            readOnly={!plan.canEdit}
            onChange={(event) => {
              setDefinition(event.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <h3>Criterios de cierre</h3>
        {checklist.map((item, index) => (
          <label className="check-row" key={item.id}>
            <input
              type="checkbox"
              checked={item.done}
              disabled={!plan.canEdit}
              onChange={(event) => {
                setChecklist((current) =>
                  current.map((entry, i) =>
                    i === index
                      ? { ...entry, done: event.target.checked }
                      : entry,
                  ),
                );
                setDirty(true);
              }}
            />
            {item.text}
            {plan.canEdit && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Quitar criterio ${item.text}`}
                onClick={() => {
                  setChecklist((current) =>
                    current.filter((_, i) => i !== index),
                  );
                  setDirty(true);
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </label>
        ))}
        {plan.canEdit && (
          <form
            className="sprint-add-criterion"
            onSubmit={(event) => {
              event.preventDefault();
              if (criterion.trim()) {
                setChecklist((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    text: criterion.trim(),
                    done: false,
                  },
                ]);
                setCriterion("");
                setDirty(true);
              }
            }}
          >
            <Field label="Nuevo criterio de cierre">
              <input
                value={criterion}
                maxLength={500}
                onChange={(event) => setCriterion(event.target.value)}
              />
            </Field>
            <button disabled={!criterion.trim() || checklist.length >= 300}>
              Añadir criterio
            </button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {plan.canEdit && (
          <div className="form-actions">
            <span>
              {busy
                ? "Actualizando el plan…"
                : dirty
                  ? "Borrador sin guardar"
                  : "Plan sincronizado"}
            </span>
            <button
              className="primary"
              disabled={busy || !dirty || !online}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await flushOutbox(user.id, workspaceId, () => {});
                  await api(
                    `${base}/planning`,
                    send(
                      {
                        operationId: crypto.randomUUID(),
                        expectedVersion: baseVersion,
                        taskIds: selected,
                        taskVersions: [...versions.current].map(
                          ([id, version]) => ({ id, version }),
                        ),
                        capacityPlan: capacity,
                        definitionOfDone: definition,
                        checklist,
                      },
                      "PUT",
                    ),
                  );
                  setDirty(false);
                  await draftStore.clear();
                  setMessage("Plan guardado.");
                  await saved();
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Guardar planificación
            </button>
          </div>
        )}
        {plan.baseline && (
          <p className="muted">
            Al inicio se conservaron {plan.baseline.tasks.length} tareas. Los
            cambios posteriores aparecen en Métricas.
          </p>
        )}
      </fieldset>
    </>
  );
}
function SprintPoker({ base, plan, members, online, refreshPlan }: any) {
  const [data, setData] = useState<any>(null),
    [taskId, setTaskId] = useState(""),
    [estimate, setEstimate] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      setData(await api(`${base}/poker`));
    } catch (error) {
      setError((error as Error).message);
    }
  }, [base]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const execute = async (path: string, body: any, method = "POST") => {
    setBusy(true);
    setError("");
    try {
      await api(path, send(body, method));
      await load();
      await refreshPlan();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const active = data?.rounds.find((round: any) =>
      ["voting", "revealed"].includes(round.status),
    ),
    task = plan.tasks.find((task: Resource) => task.id === active?.task_id),
    roundStates: Record<string, string> = {
      voting: "Votación oculta",
      revealed: "Cartas reveladas",
      applied: "Estimación aplicada",
      cancelled: "Ronda cancelada",
    };
  return (
    <div className="sprint-poker">
      <h3>Estimación compartida</h3>
      <button
        disabled={busy || !online}
        onClick={() => {
          setError("");
          void load();
          void refreshPlan();
        }}
      >
        Actualizar ronda y tarea
      </button>
      <p className="muted">
        Cada persona guarda su carta. Solo verá las cartas del resto cuando
        quien facilita la ronda las revele. La estimación final se aplica con
        una confirmación explícita.
      </p>
      {error && <p role="alert">{error}</p>}
      {data?.canCreate && !active && (
        <div className="form-grid">
          <Field label="Tarea para estimar">
            <select
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">Selecciona una tarea</option>
              {plan.tasks.map((task: Resource) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </Field>
          <button
            disabled={busy || !online || !taskId}
            onClick={() =>
              void execute(`${base}/poker`, {
                operationId: crypto.randomUUID(),
                taskId,
                expectedTaskVersion: plan.tasks.find(
                  (task: Resource) => task.id === taskId,
                )?.version,
              })
            }
          >
            Iniciar ronda
          </button>
        </div>
      )}
      {active && (
        <section className="poker-active">
          <h4>{task?.title || "Tarea de la ronda"}</h4>
          <p role="status">
            {roundStates[active.status]} · {active.participants.length} cartas
            guardadas
          </p>
          {active.status === "voting" && data.canVote && (
            <div
              className="poker-deck"
              role="group"
              aria-label="Elige tu carta"
            >
              {pokerDeck.map((value) => (
                <button
                  key={value}
                  aria-pressed={active.ownVote === value}
                  disabled={busy || !online}
                  onClick={() =>
                    void execute(
                      `${base}/poker/${active.id}/vote`,
                      { value },
                      "PUT",
                    )
                  }
                >
                  {value === "coffee" ? "Descanso" : value}
                </button>
              ))}
            </div>
          )}
          {active.ownVote && (
            <p>
              Tu carta:{" "}
              {active.ownVote === "coffee" ? "Descanso" : active.ownVote}
            </p>
          )}
          <ul className="poker-participants">
            {active.participants.map((participant: any) => (
              <li key={participant.userId}>
                <span>
                  {members.find(
                    (member: any) => member.id === participant.userId,
                  )?.name || "Participante"}
                </span>
                <strong>
                  {participant.value === undefined
                    ? "Carta oculta"
                    : participant.value === "coffee"
                      ? "Descanso"
                      : participant.value}
                </strong>
              </li>
            ))}
          </ul>
          {active.canFacilitate && (
            <div className="poker-controls">
              {active.status === "voting" && (
                <button
                  disabled={busy || !online || !active.participants.length}
                  onClick={() =>
                    void execute(`${base}/poker/${active.id}/reveal`, {
                      operationId: crypto.randomUUID(),
                      expectedVersion: active.version,
                    })
                  }
                >
                  Revelar cartas
                </button>
              )}
              {active.status === "revealed" && (
                <>
                  <Field label="Estimación acordada en puntos">
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      step="0.5"
                      value={estimate}
                      onChange={(event) => setEstimate(event.target.value)}
                    />
                  </Field>
                  <p>
                    Estimación actual de la tarea: {task?.data.estimate || 0}{" "}
                    puntos. No se aplica ningún promedio automáticamente.
                  </p>
                  <button
                    disabled={busy || !online || estimate === ""}
                    onClick={() =>
                      void execute(`${base}/poker/${active.id}/apply`, {
                        operationId: crypto.randomUUID(),
                        expectedVersion: active.version,
                        expectedTaskVersion: task?.version,
                        estimate: Number(estimate),
                      })
                    }
                  >
                    Aplicar estimación acordada
                  </button>
                </>
              )}
              <button
                className="text-button"
                disabled={busy || !online}
                onClick={() =>
                  void execute(`${base}/poker/${active.id}/cancel`, {
                    operationId: crypto.randomUUID(),
                    expectedVersion: active.version,
                  })
                }
              >
                Cancelar ronda
              </button>
            </div>
          )}
        </section>
      )}
      {!active && data && !data.rounds.length && <p>No hay rondas todavía.</p>}
      <h4>Rondas anteriores</h4>
      {data?.rounds
        .filter((round: any) => !["voting", "revealed"].includes(round.status))
        .map((round: any) => (
          <article className="poker-history" key={round.id}>
            <strong>
              {plan.tasks.find((task: Resource) => task.id === round.task_id)
                ?.title || "Tarea"}
            </strong>
            <span>
              {roundStates[round.status]}
              {round.applied_estimate !== null
                ? ` · ${round.applied_estimate} puntos`
                : ""}
            </span>
            <time>{new Date(round.created_at).toLocaleString("es")}</time>
            <details>
              <summary>Cartas de esta ronda</summary>
              {round.revealed_at || round.status === "applied" ? (
                <ul>
                  {round.participants.map((participant: any) => (
                    <li key={participant.userId}>
                      {members.find(
                        (member: any) => member.id === participant.userId,
                      )?.name || "Participante"}
                      :{" "}
                      {participant.value === "coffee"
                        ? "Descanso"
                        : participant.value}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Esta ronda terminó sin revelar las cartas.</p>
              )}
            </details>
          </article>
        ))}
    </div>
  );
}
function SprintReview({
  base,
  sprint,
  resources,
  members,
  user,
  workspaceId,
  create,
  canEdit,
  online,
}: any) {
  const [draft, setDraft] = useState<Ceremony>(emptyCeremony),
    [version, setVersion] = useState(0),
    [history, setHistory] = useState<any[]>([]),
    [before, setBefore] = useState<number | null>(null),
    [actionTitle, setActionTitle] = useState(""),
    [actionFields, setActionFields] = useState<
      Record<string, CustomFieldValue>
    >({}),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await api(`${base}/ceremonies`);
      void writeUserDraft(
        user.id,
        `${workspaceId}:${sprint.id}:review-cache`,
        data,
      ).catch(() =>
        setError(
          "La revisión está disponible en línea, pero no se ha podido actualizar su copia local.",
        ),
      );
      setDraft(data.data);
      setVersion(data.version);
      setDirty(false);
      setLoaded(true);
    } catch (error) {
      if (!navigator.onLine) {
        try {
          const cached = await readUserDraft(
            user.id,
            `${workspaceId}:${sprint.id}:review-cache`,
          );
          if (cached) {
            setDraft(ceremonySchema.parse(cached.data));
            setVersion(cached.version);
            setDirty(false);
            setLoaded(true);
            setError("");
            return;
          }
        } catch {}
      }
      setError((error as Error).message);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  const draftStore = useSprintDraft(
    user.id,
    `${workspaceId}:${sprint.id}:review`,
    { data: draft, version, actionTitle, actionFields },
    dirty,
    (value) => {
      const data = ceremonySchema.parse(value.data);
      if (
        !Number.isInteger(value.version) ||
        value.version < 0 ||
        typeof value.actionTitle !== "string"
      )
        throw new Error("Invalid local ceremony draft");
      setDraft(data);
      setVersion(value.version);
      setActionTitle(value.actionTitle);
      const entries = Object.entries(value.actionFields || {});
      if (
        entries.some(
          ([key, value]) =>
            key.length > 80 || !customFieldValueSchema.safeParse(value).success,
        )
      )
        throw new Error("Invalid action field draft");
      setActionFields(value.actionFields || {});
      setDirty(true);
    },
    loaded && canEdit,
  );
  const update = (
    section: "review" | "retrospective",
    field: string,
    value: any,
  ) => {
    setDraft((current) => ({
      ...current,
      [section]: { ...current[section], [field]: value },
    }));
    setDirty(true);
  };
  return (
    <>
      <div className="sprint-draft-status">
        {draftStore.issue && <p role="alert">{draftStore.issue}</p>}
        {dirty && (
          <p role="status">
            {draftStore.saved
              ? "Borrador de revisión guardado en este dispositivo."
              : "Guardando borrador de revisión…"}
          </p>
        )}
        <button
          onClick={async () => {
            if (
              (!dirty && !draftStore.issue) ||
              confirm(
                "¿Descartar el borrador de revisión y volver a los datos del servidor?",
              )
            ) {
              setDirty(false);
              await draftStore.clear();
              await load();
            }
          }}
        >
          Recargar revisión
        </button>
      </div>
      <fieldset
        className="sprint-review sprint-form"
        aria-label="Revisión y retrospectiva del sprint"
        disabled={busy || !loaded || !draftStore.ready}
      >
        <div className="section-heading">
          <h3>Revisión del resultado</h3>
        </div>
        <Field label="Resultado del objetivo">
          <select
            disabled={!canEdit}
            value={draft.review.outcome}
            onChange={(event) =>
              update("review", "outcome", event.target.value)
            }
          >
            <option value="pending">Pendiente de revisar</option>
            <option value="achieved">Conseguido</option>
            <option value="partial">Parcialmente conseguido</option>
            <option value="missed">No conseguido</option>
          </select>
        </Field>
        <Field label="Trabajo entregado y demostración">
          <textarea
            rows={4}
            readOnly={!canEdit}
            value={draft.review.delivered}
            maxLength={20000}
            onChange={(event) =>
              update("review", "delivered", event.target.value)
            }
          />
        </Field>
        <Field label="Comentarios de las personas interesadas">
          <textarea
            rows={3}
            readOnly={!canEdit}
            value={draft.review.feedback}
            maxLength={20000}
            onChange={(event) =>
              update("review", "feedback", event.target.value)
            }
          />
        </Field>
        <h3>Retrospectiva del equipo</h3>
        <Field label="Qué funcionó bien">
          <textarea
            rows={3}
            readOnly={!canEdit}
            value={draft.retrospective.wentWell}
            maxLength={20000}
            onChange={(event) =>
              update("retrospective", "wentWell", event.target.value)
            }
          />
        </Field>
        <Field label="Qué queremos mejorar">
          <textarea
            rows={3}
            readOnly={!canEdit}
            value={draft.retrospective.improve}
            maxLength={20000}
            onChange={(event) =>
              update("retrospective", "improve", event.target.value)
            }
          />
        </Field>
        <Field label="Tareas de seguimiento">
          <select
            multiple
            disabled={!canEdit}
            value={draft.retrospective.actionIds}
            onChange={(event) =>
              update(
                "retrospective",
                "actionIds",
                [...event.target.selectedOptions].map((option) => option.value),
              )
            }
          >
            {resources
              .filter(
                (resource: Resource) =>
                  resource.kind === "task" && !resource.deleted_at,
              )
              .map((resource: Resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.title}
                </option>
              ))}
          </select>
        </Field>
        {canEdit && (
          <form
            className="sprint-add-criterion"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                const resource = await create("task", actionTitle, {
                  status: "backlog",
                  taskType: "maintenance",
                  projectId: sprint.data.projectId || null,
                  targetId: sprint.id,
                  customFields: {
                    ...fieldDefaults(
                      resources.find(
                        (r: Resource) => r.id === sprint.data.projectId,
                      )?.data.fieldDefinitions || [],
                    ),
                    ...actionFields,
                  },
                });
                await flushOutbox(user.id, workspaceId, () => {});
                if (resource)
                  update("retrospective", "actionIds", [
                    ...draft.retrospective.actionIds,
                    resource.id,
                  ]);
                setActionTitle("");
                setActionFields({});
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Nueva acción de mejora">
              <input
                required
                maxLength={500}
                value={actionTitle}
                onChange={(event) => {
                  setActionTitle(event.target.value);
                  setDirty(true);
                }}
              />
            </Field>
            <ConfiguredTaskFields
              definitions={
                resources.find((r: Resource) => r.id === sprint.data.projectId)
                  ?.data.fieldDefinitions || []
              }
              values={{
                ...fieldDefaults(
                  resources.find(
                    (r: Resource) => r.id === sprint.data.projectId,
                  )?.data.fieldDefinitions || [],
                ),
                ...actionFields,
              }}
              change={(values) => {
                setActionFields(values);
                setDirty(true);
              }}
              editable={canEdit}
              members={members}
              required
            />
            <button disabled={busy || !online || !actionTitle.trim()}>
              <Plus size={15} />
              Crear tarea de mejora
            </button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {canEdit && (
          <button
            className="primary"
            disabled={busy || !online || !dirty}
            onClick={async () => {
              if (actionTitle.trim()) {
                setError(
                  "Crea la tarea de mejora o vacía su título antes de guardar la revisión.",
                );
                return;
              }
              setBusy(true);
              try {
                await api(
                  `${base}/ceremonies`,
                  send(
                    {
                      operationId: crypto.randomUUID(),
                      expectedVersion: version,
                      data: draft,
                    },
                    "PUT",
                  ),
                );
                setDirty(false);
                await draftStore.clear();
                await load();
                setMessage("Revisión y retrospectiva guardadas.");
                setError("");
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Guardar revisión y retrospectiva
          </button>
        )}
        <details>
          <summary>Versiones de revisión y retrospectiva</summary>
          <button
            onClick={async () => {
              try {
                const result = await api(`${base}/ceremonies/versions`);
                setHistory(result.versions);
                setBefore(result.nextBefore);
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          >
            Consultar versiones
          </button>
          {history.map((entry) => (
            <article className="ceremony-version" key={entry.version}>
              <strong>
                Versión {entry.version} ·{" "}
                {new Date(entry.created_at).toLocaleString("es")}
              </strong>
              <p>{entry.data.review.delivered || "Sin resumen de entrega."}</p>
              {canEdit && (
                <button
                  onClick={() => {
                    setDraft(entry.data);
                    setDirty(true);
                  }}
                >
                  Usar esta versión como borrador
                </button>
              )}
            </article>
          ))}
          {before && (
            <button
              onClick={async () => {
                const result = await api(
                  `${base}/ceremonies/versions?before=${before}`,
                );
                setHistory((current) => [...current, ...result.versions]);
                setBefore(result.nextBefore);
              }}
            >
              Cargar versiones anteriores
            </button>
          )}
        </details>
      </fieldset>
    </>
  );
}
function SprintMetrics({ base, open, resources }: any) {
  const duration = (hours: number) =>
    hours > 0 && hours < 1 / 60
      ? "menos de un minuto"
      : hours < 1
        ? `${Math.round(hours * 60)} minutos`
        : `${Math.round(hours * 10) / 10} horas`;
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void api(`${base}/metrics`)
      .then((result) => {
        if (!disposed) setData(result);
      })
      .catch((error) => {
        if (!disposed) setError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [base]);
  if (error) return <p role="alert">{error}</p>;
  if (!data)
    return <p role="status">Calculando métricas a partir del historial…</p>;
  if (!data.available)
    return (
      <p>
        {data.reason === "no_baseline"
          ? "El gráfico estará disponible cuando se conserve el alcance al iniciar el sprint. Los sprints anteriores a esta función no tienen una línea inicial reconstruida."
          : "Este historial supera el límite de cálculo interactivo; no se muestra una curva parcial."}
      </p>
    );
  return (
    <div className="sprint-metrics">
      <h3>Alcance y entrega</h3>
      <div className="sprint-metric-values">
        <p>
          <span>Puntos iniciales</span>
          <strong>{data.baseline.scope}</strong>
        </p>
        <p>
          <span>Puntos en el alcance final</span>
          <strong>{data.final.scope}</strong>
        </p>
        <p>
          <span>Puntos completados</span>
          <strong>{data.final.done}</strong>
        </p>
        <p>
          <span>Tareas sin estimación</span>
          <strong>{data.final.unestimated}</strong>
        </p>
      </div>
      <SprintChart
        title="Burndown: puntos pendientes"
        series={data.series}
        lines={[["remaining", "Pendientes"]]}
      />
      <SprintChart
        title="Burnup: alcance y puntos completados"
        series={data.series}
        lines={[
          ["scope", "Alcance"],
          ["done", "Completados"],
        ]}
      />
      <details>
        <summary>Datos accesibles de los gráficos</summary>
        <div className="sprint-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Alcance</th>
                <th>Completados</th>
                <th>Pendientes</th>
              </tr>
            </thead>
            <tbody>
              {data.series.map((point: any, index: number) => (
                <tr key={index}>
                  <th>{new Date(point.at).toLocaleString("es")}</th>
                  <td>{point.scope}</td>
                  <td>{point.done}</td>
                  <td>{point.remaining}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <h3>Tiempo de entrega registrado</h3>
      <p>
        Desde la creación hasta la primera finalización:{" "}
        {data.leadHours === null
          ? "sin datos suficientes"
          : `${duration(data.leadHours)} de media (${data.leadSamples} tareas)`}
        .
      </p>
      <p>
        Desde el primer «En curso» hasta la primera finalización:{" "}
        {data.cycleHours === null
          ? "sin datos suficientes"
          : `${duration(data.cycleHours)} de media (${data.cycleSamples} tareas)`}
        .
      </p>
      <p className="muted">
        Los tiempos dependen de los cambios de estado registrados. No se imputan
        horas de trabajo ni se convierten puntos en tiempo.
        {data.sampled
          ? " El gráfico agrupa fechas para limitar el número de puntos."
          : ""}
      </p>
      <h3>Cambios de alcance</h3>
      {!data.changes.length && (
        <p>No se han registrado cambios desde el inicio.</p>
      )}
      {data.changes.map((change: any, index: number) => {
        const task = resources.find(
          (resource: Resource) => resource.id === change.taskId,
        );
        return (
          <article className="scope-change" key={index}>
            <time>{new Date(change.at).toLocaleString("es")}</time>
            {task ? (
              <button className="text-button" onClick={() => open(task)}>
                {change.title}
              </button>
            ) : (
              <span>{change.title}</span>
            )}
            <span>
              {change.type === "added"
                ? "Añadida al alcance"
                : change.type === "removed"
                  ? "Retirada del alcance"
                  : `Estimación: ${change.before} → ${change.after}`}
            </span>
          </article>
        );
      })}
    </div>
  );
}
function SprintChart({
  title,
  series,
  lines,
}: {
  title: string;
  series: any[];
  lines: string[][];
}) {
  const id = useId(),
    width = 600,
    height = 200,
    pad = 32,
    max = Math.max(
      1,
      ...series.flatMap((point) => lines.map(([key]) => point[key])),
    ),
    start = Date.parse(series[0].at),
    end = Date.parse(series[series.length - 1].at),
    colors = ["var(--accent)", "#bd813d"];
  return (
    <figure className="sprint-chart">
      <figcaption id={id}>{title}</figcaption>
      <div className="chart-context">
        <span>{max} puntos</span>
        <span>
          {new Date(start).toLocaleString("es", {
            dateStyle: "short",
            timeStyle: "short",
          })}{" "}
          —{" "}
          {new Date(end).toLocaleString("es", {
            dateStyle: "short",
            timeStyle: "short",
          })}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id}>
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="currentColor"
          opacity=".3"
        />
        {lines.map(([key, label], index) => (
          <polyline
            key={key}
            fill="none"
            stroke={colors[index]}
            strokeWidth="3"
            points={series
              .flatMap((point, index) => {
                const x =
                    pad +
                    ((Date.parse(point.at) - start) /
                      Math.max(1, end - start)) *
                      (width - 2 * pad),
                  y = height - pad - (point[key] / max) * (height - 2 * pad);
                return index
                  ? [
                      `${x},${height - pad - (series[index - 1][key] / max) * (height - 2 * pad)}`,
                      `${x},${y}`,
                    ]
                  : [`${x},${y}`];
              })
              .join(" ")}
          >
            <title>{label}</title>
          </polyline>
        ))}
      </svg>
      <div className="chart-legend">
        {lines.map(([key, label], index) => (
          <span key={key}>
            <i style={{ background: colors[index] }} />
            {label}
          </span>
        ))}
      </div>
    </figure>
  );
}
