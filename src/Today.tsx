import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Bell, CircleCheck, Circle, Clock, FileText, Inbox, Plus } from "lucide-react";
import type { Resource, User } from "../shared/model";
import { stateLabel } from "../shared/workflow";
import { sprintStats } from "../shared/model";

const localDay = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const addDays = (day: string, offset: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + offset));
};
const shortDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric" })
    .format(new Date(y, m - 1, d))
    .replace(".", "");
};
const clockText = (seconds: number) =>
  [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
const durationText = (seconds: number) => {
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const timeOf = (iso: string) =>
  new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );

/** Daily home: what is due, what is running and what needs a reply. */
export default function Today({
  resources,
  projects,
  user,
  open,
  navigate,
  complete,
  capture,
  canEdit,
}: {
  resources: Resource[];
  projects: Resource[];
  user: User;
  open: (resource: Resource) => void;
  navigate: (page: any, id?: string | null) => void;
  complete: (task: Resource) => Promise<unknown>;
  capture: () => void;
  canEdit: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const today = localDay(new Date(now)),
    week = addDays(today, 7);
  const live = resources.filter((r) => !r.deleted_at);
  const mine = useMemo(
    () =>
      live
        .filter(
          (t) =>
            t.kind === "task" &&
            t.data.assigneeId === user.id &&
            !["done", "cancelled"].includes(t.data.status),
        )
        .sort((a, b) =>
          (a.data.dueDate || "9999").localeCompare(b.data.dueDate || "9999"),
        ),
    [resources, user.id],
  );
  const groups = [
    {
      id: "overdue",
      label: "Vencidas",
      tone: "late",
      items: mine.filter((t) => t.data.dueDate && t.data.dueDate < today),
    },
    {
      id: "today",
      label: "Hoy",
      tone: "",
      items: mine.filter(
        (t) =>
          t.data.dueDate === today ||
          (!t.data.dueDate && ["in_progress", "review"].includes(t.data.status)),
      ),
    },
    {
      id: "week",
      label: "Próximos 7 días",
      tone: "quiet",
      items: mine.filter(
        (t) => t.data.dueDate && t.data.dueDate > today && t.data.dueDate <= week,
      ),
    },
  ];
  const pending = groups.reduce((n, g) => n + g.items.length, 0);
  const projectTitle = (task: Resource) =>
    projects.find((p) => p.id === task.data.projectId)?.title || "Sin proyecto";

  const logs = live.filter(
      (r) => r.kind === "time_entry" && r.created_by === user.id && r.data.timeLog,
    ),
    running = logs.find((r) => r.data.timeLog.status === "running"),
    elapsed = (log: Resource) =>
      log.data.timeLog.status === "running"
        ? Math.max(
            0,
            Math.floor((now - Date.parse(log.data.timeLog.startedAt || "")) / 1000),
          )
        : log.data.timeLog.seconds || 0,
    loggedToday = logs
      .filter((r) => r.data.timeLog.date === today)
      .reduce((sum, r) => sum + elapsed(r), 0);
  const unread = live.filter(
    (r) =>
      r.kind === "notification" &&
      r.data.assigneeId === user.id &&
      !r.data.read &&
      !(r.data.snoozedUntil && Date.parse(r.data.snoozedUntil) > Date.now()),
  );
  const reminders = live
    .filter(
      (r) =>
        r.kind === "reminder" &&
        r.data.reminder?.enabled &&
        localDay(new Date(r.data.reminder.at)) === today,
    )
    .sort((a, b) => a.data.reminder.at.localeCompare(b.data.reminder.at));
  const sprint = live.find(
      (r) => r.kind === "sprint" && r.data.status === "active",
    ),
    sprintTasks = sprint
      ? live.filter((t) => t.kind === "task" && t.data.sprintId === sprint.id)
      : [],
    sprintProgress = sprintStats(sprintTasks),
    daysLeft =
      sprint?.data.endDate && sprint.data.endDate >= today
        ? Math.round(
            (Date.parse(sprint.data.endDate) - Date.parse(today)) / 86_400_000,
          )
        : null;
  const recent = live
    .filter((r) => r.kind === "document")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 3);

  const tiles = [
    { id: "late", label: "Vencidas", value: String(groups[0].items.length), meta: groups[0].items.length ? "Revisa primero" : "Nada atrasado", icon: AlertTriangle, go: "my_tasks" },
    { id: "today", label: "Para hoy", value: String(groups[1].items.length), meta: `${groups[2].items.length} en los próximos 7 días`, icon: CircleCheck, go: "my_tasks" },
    { id: "inbox", label: "Bandeja", value: String(unread.length), meta: unread.length ? "Sin leer" : "Estás al día", icon: Inbox, go: "inbox" },
    { id: "time", label: "Tiempo hoy", value: durationText(loggedToday), meta: running ? "Reloj en marcha" : "Sin reloj en marcha", icon: Clock, go: "time" },
  ];

  return (
    <div className="today">
      <div className="today-tiles">
        {tiles.map(({ id, label, value, meta, icon: Icon, go }) => (
          <button key={id} className={`today-tile tone-${id}`} onClick={() => navigate(go)}>
            <span className="today-tile-label">
              <span className="today-tile-icon"><Icon size={15} /></span>
              {label}
            </span>
            <strong>{value}</strong>
            <small>{meta}</small>
          </button>
        ))}
      </div>
      {canEdit && (
        <button className="today-capture" onClick={capture}>
          <Plus size={18} />
          <span>Apunta una idea, tarea o nota sin salir de aquí…</span>
          <kbd>Alt Q</kbd>
        </button>
      )}
      <div className="today-layout">
        <section className="today-tasks" aria-labelledby="today-tasks-title">
          <div className="today-section-head">
            <h2 id="today-tasks-title">Para hoy</h2>
            <span className="muted">
              {pending
                ? `${pending} ${pending === 1 ? "pendiente" : "pendientes"}${groups[0].items.length ? ` · ${groups[0].items.length} vencidas` : ""}`
                : "Nada pendiente para hoy"}
            </span>
            <button className="text-button" onClick={() => navigate("my_tasks")}>
              Todas mis tareas
              <ArrowRight size={14} />
            </button>
          </div>
          {!pending && (
            <p className="today-empty">
              No tienes tareas vencidas ni para esta semana. Las tareas que te
              asignen con fecha aparecerán aquí.
            </p>
          )}
          {groups
            .filter((g) => g.items.length || (g.id === "today" && reminders.length))
            .map((group) => (
              <div key={group.id} className="today-group">
                <h3 className={`today-group-title ${group.tone}`}>
                  <span>
                    {group.label} ·{" "}
                    {group.items.length + (group.id === "today" ? reminders.length : 0)}
                  </span>
                </h3>
                <ul>
                  {group.id === "today" &&
                    reminders.map((r) => (
                      <li key={r.id} className="today-task today-reminder">
                        <span className="today-time-label">{timeOf(r.data.reminder.at)}</span>
                        <button className="today-task-main" onClick={() => open(r)}>
                          <strong>{r.title}</strong>
                          <small>
                            <Bell size={12} /> Recordatorio
                          </small>
                        </button>
                      </li>
                    ))}
                  {group.items.slice(0, 8).map((task) => (
                    <li key={task.id} className="today-task">
                      {canEdit && (
                        <button
                          className="today-complete"
                          aria-label={`Completar ${task.title}`}
                          onClick={() => void complete(task)}
                        >
                          <Circle size={17} />
                        </button>
                      )}
                      <button className="today-task-main" onClick={() => open(task)}>
                        <strong>{task.title}</strong>
                        <small>
                          <span
                            className="today-project-dot"
                            style={{ background: projects.find((p) => p.id === task.data.projectId)?.data.color || "var(--muted)" }}
                          />
                          {projectTitle(task)}
                        </small>
                      </button>
                      <span className={`today-chip status-${task.data.status}`}>{stateLabel(task, projects)}</span>
                      <span className={`today-due ${group.tone}`}>
                        {task.data.dueDate
                          ? task.data.dueDate === today
                            ? "Hoy"
                            : task.data.dueDate === addDays(today, -1)
                              ? "Ayer"
                              : shortDay(task.data.dueDate)
                          : "Sin fecha"}
                      </span>
                    </li>
                  ))}
                </ul>
                {group.items.length > 8 && (
                  <button className="text-button" onClick={() => navigate("my_tasks")}>
                    Ver {group.items.length - 8} más
                  </button>
                )}
              </div>
            ))}
        </section>

        <aside className="today-side">
          <section className={`today-card today-clock-card ${running ? "running" : ""}`} aria-labelledby="today-clock-title">
            <div className="today-card-head">
              <h2 id="today-clock-title">Reloj</h2>
              <span className="muted">Hoy {durationText(loggedToday)}</span>
            </div>
            {running ? (
              <>
                <p className="muted today-clock-label">
                  En curso · {running.title}
                </p>
                <div className="today-clock">
                  <span className="today-clock-time">{clockText(elapsed(running))}</span>
                  <button onClick={() => navigate("time")}>Ver reloj</button>
                </div>
              </>
            ) : (
              <div className="today-clock">
                <span className="muted">Ningún reloj en marcha.</span>
                <button onClick={() => navigate("time")}>Registrar tiempo</button>
              </div>
            )}
          </section>

          <section className="today-card" aria-labelledby="today-inbox-title">
            <div className="today-card-head">
              <h2 id="today-inbox-title">Bandeja</h2>
              {unread.length > 0 && (
                <span className="today-badge">
                  {unread.length} {unread.length === 1 ? "nueva" : "nuevas"}
                </span>
              )}
              <button className="text-button" onClick={() => navigate("inbox")}>
                Abrir
              </button>
            </div>
            {unread.length ? (
              <ul>
                {unread.slice(0, 3).map((n) => (
                  <li key={n.id}>
                    <button className="today-row" onClick={() => navigate("inbox")}>
                      <span>{n.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Estás al día.</p>
            )}
          </section>


          {sprint && (
            <section className="today-card" aria-labelledby="today-sprint-title">
              <div className="today-card-head">
                <h2 id="today-sprint-title">{sprint.title}</h2>
                {daysLeft !== null && (
                  <span className="muted">
                    {daysLeft === 0
                      ? "Termina hoy"
                      : `Quedan ${daysLeft} ${daysLeft === 1 ? "día" : "días"}`}
                  </span>
                )}
              </div>
              <div className="progress-track">
                <span style={{ width: `${sprintProgress.percent}%` }} />
              </div>
              <button className="today-row muted" onClick={() => open(sprint)}>
                {sprintProgress.done} de {sprintProgress.total} tareas completadas
              </button>
            </section>
          )}
        </aside>
      </div>

      {recent.length > 0 && (
        <section className="today-recent" aria-labelledby="today-recent-title">
          <h2 id="today-recent-title">Continuar donde lo dejaste</h2>
          <div>
            {recent.map((d) => (
              <button key={d.id} onClick={() => open(d)}>
                <span className={`today-doc-icon ${d.data.personalNote ? "note" : ""}`}>
                  <FileText size={17} />
                </span>
                <span>
                  <strong>{d.title}</strong>
                  <small>
                    {d.data.personalNote ? "Nota privada" : "Documento"} ·{" "}
                    {new Intl.DateTimeFormat("es", {
                      day: "numeric",
                      month: "short",
                    }).format(new Date(d.updated_at))}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
