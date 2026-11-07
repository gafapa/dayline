import { useState } from "react";
import type { Resource } from "../shared/model";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toLocaleDateString("en-CA");
const weekStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};
const periods = [
  [1, "Semana"],
  [4, "Mes"],
  [8, "8 semanas"],
  [13, "Trimestre"],
] as const;

/**
 * The top of Informes y tiempo: four numbers compared with the previous period, completions
 * per week, hours per project and the work that needs attention. With `compact` only the
 * numbers are shown (the Tiempo tab).
 */
export default function WorkOverview({
  resources,
  projectId,
  compact = false,
  goTasks,
}: {
  resources: Resource[];
  projectId: string | null;
  compact?: boolean;
  goTasks: (filter: string) => void;
}) {
  const [weeks, setWeeks] = useState<number>(8);
  const now = Date.now();
  const today = iso(now);
  const thisWeek = weekStart(now);
  const from = thisWeek - (weeks - 1) * 7 * DAY;
  const before = from - weeks * 7 * DAY;
  const projects = resources.filter((r) => r.kind === "project");
  const inScope = (r: Resource) => !projectId || r.data.projectId === projectId;
  const tasks = resources.filter((r) => r.kind === "task" && inScope(r));
  const open = tasks.filter((t) => !["done", "cancelled"].includes(t.data.status));
  const doneAt = (t: Resource) => (t.data.status === "done" ? Date.parse(t.updated_at) : NaN);
  const doneIn = (a: number, b: number) => tasks.filter((t) => doneAt(t) >= a && doneAt(t) < b);
  const completed = doneIn(from, now + DAY).length;
  const previous = doneIn(before, from).length;
  const change = previous ? Math.round(((completed - previous) / previous) * 100) : null;
  const late = open.filter((t) => t.data.dueDate && t.data.dueDate < today);
  const unassigned = open.filter((t) => !t.data.assigneeId);
  const entries = resources.filter((r) => r.kind === "time_entry" && r.data.timeLog?.date);
  const projectOf = (entry: Resource) =>
    entry.data.projectId || resources.find((r) => r.id === entry.data.targetId)?.data.projectId;
  const scopedEntries = entries.filter((e) => !projectId || projectOf(e) === projectId);
  const seconds = (list: Resource[]) => list.reduce((n, e) => n + (e.data.timeLog.seconds || 0), 0);
  const inPeriod = scopedEntries.filter((e) => e.data.timeLog.date >= iso(from));
  const hours = Math.round(seconds(inPeriod) / 360) / 10;
  const hoursWeek = Math.round(seconds(scopedEntries.filter((e) => e.data.timeLog.date >= iso(thisWeek))) / 360) / 10;
  const cycle = (() => {
    const durations = doneIn(from, now + DAY)
      .map((t) => (Date.parse(t.updated_at) - Date.parse(t.created_at)) / DAY)
      .filter((d) => d >= 0);
    return durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null;
  })();

  const kpis = (
    <section className="work-overview-kpis" aria-label="Indicadores">
      <div>
        <small>Completadas</small>
        <strong>{completed}</strong>
        <span>
          {change === null ? "sin periodo anterior" : `${change >= 0 ? "+" : ""}${change} % frente al periodo anterior`}
        </span>
      </div>
      <div>
        <small>Vencidas</small>
        <strong className={late.length ? "late" : ""}>{late.length}</strong>
        <span>{late.length ? "revisa prioridades" : "nada atrasado"}</span>
      </div>
      <div>
        <small>Ciclo medio</small>
        <strong>{cycle === null ? "—" : `${String(cycle).replace(".", ",")} días`}</strong>
        <span>de creada a hecha</span>
      </div>
      <div>
        <small>Horas</small>
        <strong>{String(hours).replace(".", ",")} h</strong>
        <span>{String(hoursWeek).replace(".", ",")} h esta semana</span>
      </div>
    </section>
  );
  const periodSwitch = (
    <div className="segmented push-end" role="group" aria-label="Periodo">
      {periods.map(([n, label]) => (
        <button key={n} aria-pressed={weeks === n} onClick={() => setWeeks(n)}>
          {label}
        </button>
      ))}
    </div>
  );
  if (compact)
    return (
      <div className="work-overview">
        <div className="page-toolbar">{periodSwitch}</div>
        {kpis}
      </div>
    );

  const bars = Array.from({ length: Math.max(weeks, 4) }, (_, i) => {
    const start = thisWeek - (Math.max(weeks, 4) - 1 - i) * 7 * DAY;
    return { start, count: doneIn(start, start + 7 * DAY).length };
  });
  const max = Math.max(1, ...bars.map((b) => b.count));
  const average = Math.round((bars.reduce((n, b) => n + b.count, 0) / bars.length) * 10) / 10;
  const byProject = projects
    .filter((p) => !projectId || p.id === projectId)
    .map((p) => {
      const own = inPeriod.filter((e) => projectOf(e) === p.id);
      return {
        p,
        hours: Math.round(seconds(own) / 360) / 10,
        tasks: doneIn(from, now + DAY).filter((t) => t.data.projectId === p.id).length,
      };
    })
    .filter((row) => row.hours || row.tasks)
    .sort((a, b) => b.hours - a.hours || b.tasks - a.tasks)
    .slice(0, 8);
  const totalHours = byProject.reduce((n, r) => n + r.hours, 0) || 1;
  const label = (t: number) =>
    new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(t)).replace(".", "");

  return (
    <div className="work-overview">
      <div className="page-toolbar">{periodSwitch}</div>
      {kpis}
      <div className="work-overview-grid">
        <section className="work-card" aria-label="Completadas por semana">
          <h2>
            Completadas por semana <small>media {String(average).replace(".", ",")}</small>
          </h2>
          <div
            className="work-bars"
            role="img"
            aria-label={`Completadas por semana: ${bars.map((b) => b.count).join(", ")}`}
          >
            {bars.map((b, i) => (
              <div key={b.start} className={i === bars.length - 1 ? "current" : ""}>
                <span style={{ height: `${Math.round((b.count / max) * 100)}%` }} title={`${b.count}`} />
                <small>{i === bars.length - 1 ? "esta" : label(b.start)}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="work-card" aria-label="Horas por proyecto">
          <h2>Horas por proyecto</h2>
          {byProject.length ? (
            <table className="work-table">
              <thead>
                <tr>
                  <th>Proyecto</th>
                  <th>Horas</th>
                  <th>Parte</th>
                  <th>Hechas</th>
                </tr>
              </thead>
              <tbody>
                {byProject.map((row) => (
                  <tr key={row.p.id}>
                    <td>{row.p.title}</td>
                    <td>{String(row.hours).replace(".", ",")} h</td>
                    <td>
                      <span className="progress-track">
                        <span style={{ width: `${Math.round((row.hours / totalHours) * 100)}%` }} />
                      </span>
                    </td>
                    <td>{row.tasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted work-empty">Sin tiempo ni tareas completadas en este periodo.</p>
          )}
        </section>
      </div>
      {(late.length > 0 || unassigned.length > 0) && (
        <section className="work-attention" aria-label="Necesita atención">
          <strong>Necesita atención</strong>
          {late.length > 0 && (
            <button className="text-button" onClick={() => goTasks("vence:vencidas")}>
              {late.length} {late.length === 1 ? "tarea vencida" : "tareas vencidas"}
            </button>
          )}
          {unassigned.length > 0 && (
            <button className="text-button" onClick={() => goTasks("@nadie")}>
              {unassigned.length} sin responsable
            </button>
          )}
        </section>
      )}
    </div>
  );
}
