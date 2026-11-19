import { ArrowRight } from "lucide-react";
import { sprintStats, type Resource } from "../shared/model";
import { statusLabels } from "../shared/task-status";

const day = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(value))
    : "";

/**
 * A sprint can mix tasks from several projects, so sprints live in "Todo el espacio". Inside a
 * project's Planificación this shows the open sprints holding its tasks and how far they are.
 */
export function ProjectSprints({
  project,
  sprints,
  tasks,
  openSprints,
}: {
  project: Resource;
  sprints: Resource[];
  tasks: Resource[];
  openSprints: () => void;
}) {
  const own = tasks.filter((t) => t.data.projectId === project.id);
  const rows = sprints
    .filter((s) => s.data.status !== "completed")
    .map((sprint) => ({ sprint, tasks: own.filter((t) => t.data.sprintId === sprint.id) }))
    .filter((row) => row.tasks.length > 0)
    .sort((a, b) => (a.sprint.data.startDate || "").localeCompare(b.sprint.data.startDate || ""));
  if (!sprints.length) return null;
  return (
    <section className="project-sprints" aria-label="Sprints con tareas de este proyecto">
      <div className="project-sprints-head">
        <h2>Sprints con tareas de este proyecto</h2>
        <button className="text-button" onClick={openSprints}>
          Todos los sprints <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
      {rows.length ? (
        <ul>
          {rows.map(({ sprint, tasks: list }) => {
            const stats = sprintStats(list);
            return (
              <li key={sprint.id}>
                <button className="project-sprint" onClick={openSprints}>
                  <span className="project-sprint-name">
                    <strong>{sprint.title}</strong>
                    <small>
                      {statusLabels[sprint.data.status] || sprint.data.status}
                      {sprint.data.startDate &&
                        ` · ${day(sprint.data.startDate)} – ${day(sprint.data.endDate)}`}
                    </small>
                  </span>
                  <span className="project-sprint-count">
                    {stats.done} de {stats.total} {stats.total === 1 ? "tarea" : "tareas"} hechas
                  </span>
                  <span className="project-sprint-bar" role="img" aria-label={`${stats.percent}% hecho`}>
                    <span style={{ width: `${stats.percent}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">Ningún sprint abierto tiene tareas de este proyecto.</p>
      )}
    </section>
  );
}
