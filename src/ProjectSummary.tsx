import { useState } from "react";
import { CheckCircle2, Circle, FileText, Flag, Plus } from "lucide-react";
import { sprintStats, type Resource } from "../shared/model";
import { stateLabel } from "../shared/workflow";
import { projectTree } from "./ProjectList";

const dayText = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" })
    .format(new Date(y, m - 1, d))
    .replace(".", "");
};
const ago = (iso: string) =>
  new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(iso));

/**
 * A project's Resumen tab: how it is going (progress over the whole branch, open, overdue,
 * next milestone), its subprojects, what is coming up, its documents, people and recent work.
 */
export default function ProjectSummary({
  project,
  resources,
  members,
  canEdit,
  openProject,
  openTab,
  open,
  createSubproject,
}: {
  project: Resource;
  resources: Resource[];
  members: { id: string; name: string }[];
  canEdit: boolean;
  openProject: (id: string) => void;
  openTab: (page: "tasks" | "documents" | "calendar" | "planning") => void;
  open: (resource: Resource) => void;
  createSubproject: (title: string) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const today = new Date().toLocaleDateString("en-CA");
  const projects = resources.filter((r) => r.kind === "project");
  const tree = projectTree(projects, resources);
  const branch = (id: string, depth = 0): string[] =>
    depth > 16 ? [] : [id, ...tree.childrenOf(id).flatMap((c) => branch(c.id, depth + 1))];
  const ids = new Set(branch(project.id));
  const tasksOf = (set: Set<string>) => resources.filter((r) => r.kind === "task" && set.has(r.data.projectId));
  const tasks = tasksOf(ids);
  const open_ = tasks.filter((t) => !["done", "cancelled"].includes(t.data.status));
  const late = open_.filter((t) => t.data.dueDate && t.data.dueDate < today);
  const stats = sprintStats(tasks);
  const milestones = resources
    .filter((r) => r.kind === "milestone" && ids.has(r.data.projectId) && !["achieved", "cancelled"].includes(r.data.status))
    .sort((a, b) => (a.data.dueDate || "9999").localeCompare(b.data.dueDate || "9999"));
  const next = milestones[0];
  const daysTo = (day: string) => Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000);
  const upcoming = [
    ...open_.filter((t) => t.data.dueDate).map((t) => ({ r: t, day: t.data.dueDate as string, milestone: false })),
    ...milestones.filter((m) => m.data.dueDate).map((m) => ({ r: m, day: m.data.dueDate as string, milestone: true })),
  ]
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(0, 6);
  const documents = resources
    // Same set as the Documentos tab: this project's own documents.
    .filter((r) => r.kind === "document" && !r.data.personalNote && r.data.projectId === project.id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const people = [...new Set(tasks.map((t) => t.data.assigneeId).filter(Boolean))]
    .map((id) => members.find((m) => m.id === id))
    .filter(Boolean) as { id: string; name: string }[];
  const activity = resources
    .filter((r) => ["task", "document", "milestone"].includes(r.kind) && ids.has(r.data.projectId))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  const children = tree.childrenOf(project.id);

  return (
    <div className="project-summary">
      <section className="summary-kpis" aria-label="Indicadores del proyecto">
        <div>
          <small>Progreso</small>
          <strong>{stats.percent} %</strong>
          <span className="progress-track">
            <span style={{ width: `${stats.percent}%` }} />
          </span>
        </div>
        <div>
          <small>Abiertas</small>
          <strong>{open_.length}</strong>
          <span>{open_.filter((t) => ["in_progress", "review"].includes(t.data.status)).length} en curso</span>
        </div>
        <div>
          <small>Vencidas</small>
          <strong className={late.length ? "late" : ""}>{late.length}</strong>
          <span>{late.length ? "revisa primero" : "nada atrasado"}</span>
        </div>
        <div>
          <small>Próximo hito</small>
          {next ? (
            <>
              <button className="summary-link" onClick={() => open(next)}>
                {next.title}
              </button>
              <span>
                {next.data.dueDate
                  ? `${dayText(next.data.dueDate)} · ${daysTo(next.data.dueDate) >= 0 ? `faltan ${daysTo(next.data.dueDate)} días` : "pasado"}`
                  : "sin fecha"}
              </span>
            </>
          ) : (
            <>
              <strong className="summary-none">Sin hitos</strong>
              <button className="text-button summary-kpi-link" onClick={() => openTab("planning")}>
                Planificar en la hoja de ruta
              </button>
            </>
          )}
        </div>
      </section>

      <div className="summary-layout">
        <div className="summary-main">
          <section className="summary-card" aria-label="Subproyectos">
            <h2>
              Subproyectos · {children.length}
              {canEdit && (
                <button className="secondary" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Subproyecto
                </button>
              )}
            </h2>
            {adding && (
              <form
                className="summary-add"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  await createSubproject(name.trim());
                  setName("");
                  setAdding(false);
                }}
              >
                <input
                  autoFocus
                  aria-label="Nombre del subproyecto"
                  placeholder="Nombre del subproyecto y Enter"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
                />
                <button className="primary" disabled={!name.trim()}>
                  Crear
                </button>
              </form>
            )}
            {children.length ? (
              <ul>
                {children.map((child) => {
                  const own = tasksOf(new Set(branch(child.id)));
                  const s = sprintStats(own);
                  const childLate = own.filter(
                    (t) => t.data.dueDate && t.data.dueDate < today && !["done", "cancelled"].includes(t.data.status),
                  ).length;
                  return (
                    <li key={child.id} className="summary-sub">
                      <span className="project-dot" style={{ background: child.data.color || "var(--accent)" }} />
                      <button className="summary-link" onClick={() => openProject(child.id)}>
                        {child.title}
                      </button>
                      <span className="progress-track">
                        <span style={{ width: `${s.percent}%` }} />
                      </span>
                      <small>
                        {s.done}/{s.total}
                      </small>
                      <small className={childLate ? "late" : ""}>{childLate ? `${childLate} vencida${childLate === 1 ? "" : "s"}` : ""}</small>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted summary-empty">Sin subproyectos. Divide el trabajo grande en partes con su propio avance.</p>
            )}
          </section>

          <section className="summary-card" aria-label="Próximas fechas">
            <h2>
              Próximas fechas
              <button className="text-button" onClick={() => openTab("calendar")}>
                Ver calendario
              </button>
            </h2>
            {upcoming.length ? (
              <ul>
                {upcoming.map(({ r, day, milestone }) => {
                  const assignee = members.find((m) => m.id === r.data.assigneeId);
                  return (
                    <li key={r.id} className={`summary-date ${milestone ? "milestone" : ""} ${day < today ? "late" : ""}`}>
                      <small className="summary-day">{dayText(day)}</small>
                      <button className="summary-link" onClick={() => open(r)}>
                        {milestone && <Flag size={13} />} {r.title}
                      </button>
                      <span className={`today-chip ${milestone ? "status-milestone" : `status-${r.data.status}`}`}>
                        {milestone ? "Hito" : stateLabel(r, projects)}
                      </span>
                      {assignee ? (
                        <span className="avatar small" title={assignee.name}>
                          {initials(assignee.name)}
                        </span>
                      ) : (
                        <span className="avatar small summary-nobody" title="Sin responsable">—</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted summary-empty">Nada con fecha. Pon fechas a las tareas para verlas aquí.</p>
            )}
          </section>
        </div>

        <aside className="summary-side">
          <section className="summary-card" aria-label="Documentos del proyecto">
            <h2>
              Documentos · {documents.length}
              <button className="text-button" onClick={() => openTab("documents")}>
                Todos
              </button>
            </h2>
            {documents.length ? (
              <ul>
                {documents.slice(0, 4).map((d) => (
                  <li key={d.id} className="summary-doc">
                    <FileText size={15} />
                    <button className="summary-link" onClick={() => open(d)}>
                      {d.title}
                    </button>
                    <small>{ago(d.updated_at)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted summary-empty">Aún no hay documentos.</p>
            )}
          </section>
          <section className="summary-card" aria-label="Personas del proyecto">
            <h2>Personas · {people.length}</h2>
            {people.length ? (
              <ul>
                {people.map((m) => (
                  <li key={m.id} className="summary-person">
                    <span className="avatar small">{initials(m.name)}</span>
                    <span className="summary-person-name">{m.name}</span>
                    <small>{open_.filter((t) => t.data.assigneeId === m.id).length} abiertas</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted summary-empty">Nadie tiene tareas asignadas aquí.</p>
            )}
          </section>
          <section className="summary-card" aria-label="Actividad reciente">
            <h2>Actividad reciente</h2>
            <ul>
              {activity.map((r) => (
                <li key={r.id} className="summary-activity">
                  {r.kind === "document" ? (
                    <FileText size={15} className="summary-kind doc" />
                  ) : r.kind === "milestone" ? (
                    <Flag size={15} className="summary-kind milestone" />
                  ) : r.data.status === "done" ? (
                    <CheckCircle2 size={15} className="summary-kind done" />
                  ) : (
                    <Circle size={15} className="summary-kind" />
                  )}
                  <button className="summary-link" onClick={() => open(r)}>
                    {r.title}
                  </button>
                  <small>
                    {r.kind === "task" && r.data.status === "done" ? "completada" : "actualizado"} · {ago(r.updated_at)}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
