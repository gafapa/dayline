import { useEffect, useMemo, useState } from "react";
import { triage } from "./triage";
import { ArrowRight, Bell, Circle, FileText, Plus } from "lucide-react";
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

/**
 * Daily home as one agenda: overdue first, then today by time (reminders and tasks), a row to
 * add something for today and a strip with the next seven days. On the side: notices waiting
 * for a decision, the clock and the week.
 */
export default function Today({
  resources,
  projects,
  user,
  open,
  navigate,
  complete,
  addToday,
  save,
  canEdit,
}: {
  resources: Resource[];
  projects: Resource[];
  user: User;
  open: (resource: Resource) => void;
  navigate: (page: any, id?: string | null) => void;
  complete: (task: Resource) => Promise<unknown>;
  addToday: (title: string) => Promise<unknown>;
  save: (resource: Resource) => Promise<unknown>;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [day, setDay] = useState<string | null>(null);
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

  const t = triage(resources, user, save);
  const nextDays = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1));
  const dueOn = (d: string) => mine.filter((task) => task.data.dueDate === d);
  const weekStart = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return localDay(date);
  })();
  const friday = addDays(weekStart, 4);
  const doneThisWeek = live.filter(
    (r) =>
      r.kind === "task" &&
      r.data.assigneeId === user.id &&
      r.data.status === "done" &&
      localDay(new Date(r.updated_at)) >= weekStart,
  ).length;
  const leftThisWeek = mine.filter((task) => task.data.dueDate && task.data.dueDate <= friday).length;
  const weekPercent =
    doneThisWeek + leftThisWeek ? Math.round((doneThisWeek / (doneThisWeek + leftThisWeek)) * 100) : 0;
  const dueLabel = (d?: string) =>
    !d ? "Sin fecha" : d === today ? "Hoy" : d === addDays(today, -1) ? "Ayer" : shortDay(d);
  const taskRow = (task: Resource, tone = "") => (
    <li key={task.id} className={`today-task ${tone}`}>
      {canEdit ? (
        <button className="today-complete" aria-label={`Completar ${task.title}`} onClick={() => void complete(task)}>
          <Circle size={17} />
        </button>
      ) : (
        <span className="today-complete" />
      )}
      <button className="today-task-main" onClick={() => open(task)}>
        <strong>{task.title}</strong>
      </button>
      <span className="today-project">
        <span
          className="today-project-dot"
          style={{ background: projects.find((p) => p.id === task.data.projectId)?.data.color || "var(--muted)" }}
        />
        {projectTitle(task)}
      </span>
      <span className={`today-chip status-${task.data.status}`}>{stateLabel(task, projects)}</span>
      <span className={`today-due ${tone}`}>{dueLabel(task.data.dueDate)}</span>
    </li>
  );
  const submit = async () => {
    const title = draft.trim();
    if (!title) return;
    await addToday(title);
    setDraft("");
  };

  return (
    <div className="today">
      <div className="today-layout">
        <section className="today-tasks" aria-label="Agenda de hoy">
          {groups[0].items.length > 0 && (
            <div className="today-group">
              <h2 className="today-group-title late">Vencidas · {groups[0].items.length}</h2>
              <ul>{groups[0].items.slice(0, 8).map((task) => taskRow(task, "late"))}</ul>
              {groups[0].items.length > 8 && (
                <button className="text-button" onClick={() => navigate("my_tasks")}>
                  Ver {groups[0].items.length - 8} más
                </button>
              )}
            </div>
          )}
          <div className="today-group">
            <h2 className="today-group-title">Hoy · {groups[1].items.length + reminders.length}</h2>
            <ul>
              {reminders.map((r) => (
                <li key={r.id} className="today-task today-reminder">
                  <span className="today-complete" aria-hidden="true">
                    <Bell size={16} />
                  </span>
                  <button className="today-task-main" onClick={() => open(r)}>
                    <strong>{r.title}</strong>
                  </button>
                  <span className="today-project">Recordatorio</span>
                  <span />
                  <span className="today-due">{timeOf(r.data.reminder.at)}</span>
                </li>
              ))}
              {groups[1].items.map((task) => taskRow(task))}
            </ul>
            {!groups[1].items.length && !reminders.length && (
              <p className="today-empty">Nada para hoy todavía. Añade algo o elige un día de abajo.</p>
            )}
            {canEdit && (
              <form
                className="today-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <Plus size={17} />
                <input
                  aria-label="Añadir para hoy"
                  placeholder="Añadir para hoy… escribe y pulsa Enter"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                {draft.trim() && (
                  <button type="submit" className="primary">
                    Añadir
                  </button>
                )}
              </form>
            )}
          </div>
          <div className="today-group">
            <h2 className="today-group-title quiet">Próximos 7 días · {groups[2].items.length}</h2>
            <div className="today-days" role="group" aria-label="Próximos 7 días">
              {nextDays.map((d) => (
                <button key={d} aria-pressed={day === d} onClick={() => setDay(day === d ? null : d)}>
                  <small>{shortDay(d)}</small>
                  <strong>{dueOn(d).length}</strong>
                </button>
              ))}
            </div>
            {day && (
              <ul>
                {dueOn(day).map((task) => taskRow(task, "quiet"))}
                {!dueOn(day).length && <li className="today-empty">Nada previsto el {shortDay(day)}.</li>}
              </ul>
            )}
          </div>
          <button className="text-button today-all" onClick={() => navigate("my_tasks")}>
            Todas mis tareas
            <ArrowRight size={14} />
          </button>
        </section>

        <aside className="today-side">
          <section className="today-card" aria-labelledby="today-inbox-title">
            <div className="today-card-head">
              <h2 id="today-inbox-title">Por decidir · {unread.length}</h2>
              <button className="text-button" onClick={() => navigate("inbox")}>
                Abrir bandeja
              </button>
            </div>
            {unread.length ? (
              <ul className="today-decide">
                {unread.slice(0, 3).map((n) => (
                  <li key={n.id}>
                    <span>{n.title}</span>
                    {canEdit && (
                      <span className="today-decide-actions">
                        {t.plannable(n) && <button onClick={() => void t.planToday(n)}>Para hoy</button>}
                        <button onClick={() => void t.snooze(n)}>Mañana</button>
                        <button onClick={() => void t.archive(n)}>Archivar</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Estás al día.</p>
            )}
          </section>

          <section className={`today-card today-clock-card ${running ? "running" : ""}`} aria-labelledby="today-clock-title">
            <div className="today-card-head">
              <h2 id="today-clock-title">Tiempo hoy</h2>
              <strong className="today-clock-total">{durationText(loggedToday)}</strong>
            </div>
            {running ? (
              <div className="today-clock">
                <span className="today-clock-label">
                  {running.title} · <span className="today-clock-time">{clockText(elapsed(running))}</span>
                </span>
                <button onClick={() => navigate("time")}>Ver reloj</button>
              </div>
            ) : (
              <div className="today-clock">
                <span className="muted">Ningún reloj en marcha.</span>
                <button onClick={() => navigate("time")}>Registrar tiempo</button>
              </div>
            )}
          </section>

          <section className="today-card" aria-labelledby="today-week-title">
            <div className="today-card-head">
              <h2 id="today-week-title">Esta semana</h2>
            </div>
            <div className="today-week-line">
              <span>Completadas</span>
              <strong>{doneThisWeek}</strong>
            </div>
            <div className="progress-track">
              <span style={{ width: `${weekPercent}%` }} />
            </div>
            <div className="today-week-line">
              <span>Pendientes hasta el viernes</span>
              <strong>{leftThisWeek}</strong>
            </div>
          </section>

          {sprint && (
            <section className="today-card" aria-labelledby="today-sprint-title">
              <div className="today-card-head">
                <h2 id="today-sprint-title">{sprint.title}</h2>
                {daysLeft !== null && (
                  <span className="muted">
                    {daysLeft === 0 ? "Termina hoy" : `Quedan ${daysLeft} ${daysLeft === 1 ? "día" : "días"}`}
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

          {recent.length > 0 && (
            <section className="today-card" aria-labelledby="today-recent-title">
              <div className="today-card-head">
                <h2 id="today-recent-title">Seguir con</h2>
              </div>
              {recent.map((d) => (
                <button key={d.id} className="today-row today-doc" onClick={() => open(d)}>
                  <FileText size={15} />
                  <span>{d.title}</span>
                </button>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

/** One line under the Hoy title: what is due and what is waiting. */
export function todaySummary(resources: Resource[], user: User) {
  const today = localDay();
  const live = resources.filter((r) => !r.deleted_at);
  const open = live.filter(
    (t) => t.kind === "task" && t.data.assigneeId === user.id && !["done", "cancelled"].includes(t.data.status),
  );
  const late = open.filter((t) => t.data.dueDate && t.data.dueDate < today).length;
  const due = open.filter((t) => t.data.dueDate === today).length;
  const inbox = live.filter(
    (r) =>
      r.kind === "notification" &&
      r.data.assigneeId === user.id &&
      !r.data.read &&
      !(r.data.snoozedUntil && Date.parse(r.data.snoozedUntil) > Date.now()),
  ).length;
  return [`${due} para hoy`, late ? `${late} vencidas` : "", inbox ? `${inbox} en la bandeja` : ""]
    .filter(Boolean)
    .join(" · ");
}
