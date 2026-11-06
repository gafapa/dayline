import { ArrowRight, ChevronRight, FolderKanban, Star } from "lucide-react";
import { sprintStats, type Resource } from "../shared/model";

/**
 * Projects as a hierarchy: one card per top-level project with its subprojects nested inside.
 * Progress on a card counts the whole branch. A search shows matches flat, each with its path.
 */
export function ProjectCards({
  projects,
  resources,
  tasks,
  query,
  favorites,
  toggleFavorite,
  openProject,
  showDetails,
  canManage,
  configureFields,
  configureWorkflow,
}: {
  projects: Resource[];
  resources: Resource[];
  tasks: Resource[];
  query: string;
  favorites: string[];
  toggleFavorite: (id: string) => void;
  openProject: (id: string) => void;
  showDetails: (project: Resource) => void;
  canManage: (project: Resource) => boolean;
  configureFields: (project: Resource) => void;
  configureWorkflow: (project: Resource) => void;
}) {
  const { parentOf, childrenOf } = projectTree(projects, resources);
  const branch = (id: string, depth = 0): string[] =>
    depth > 16 ? [] : [id, ...childrenOf(id).flatMap((c) => branch(c.id, depth + 1))];
  const stats = (id: string) => {
    const ids = new Set(branch(id));
    return sprintStats(tasks.filter((t) => ids.has(t.data.projectId)));
  };
  const path = (project: Resource) => {
    const names: string[] = [];
    for (let p = parentOf(project.id); p && names.length < 16; p = parentOf(p.id)) names.unshift(p.title);
    return names.join(" › ");
  };
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? projects.filter((p) => p.title.toLowerCase().includes(needle))
    : projects.filter((p) => !parentOf(p.id));

  const subtree = (id: string, depth = 0): React.ReactNode => {
    const children = childrenOf(id);
    if (!children.length || depth > 8) return null;
    return (
      <ul className={depth ? "" : "project-children"} aria-label={depth ? undefined : "Subproyectos"}>
        {children.map((child) => {
          const s = stats(child.id);
          return (
            <li key={child.id}>
              <button className="project-child" onClick={() => openProject(child.id)}>
                <ChevronRight size={14} aria-hidden="true" />
                <span>{child.title}</span>
                <small>{s.total ? `${s.done}/${s.total}` : ""}</small>
              </button>
              {subtree(child.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="projects-grid">
      {shown.map((project) => {
        const s = stats(project.id);
        const favorite = favorites.includes(project.id);
        const location = needle ? path(project) : "";
        const subprojects = branch(project.id).length - 1;
        return (
          <article className="project-card" key={project.id}>
            <div className="project-card-header">
              <span
                className="project-card-icon"
                style={{ background: project.data.color || "var(--accent)" }}
              >
                <FolderKanban size={16} />
              </span>
              <button
                className="card-title"
                aria-label={project.title}
                onClick={() => openProject(project.id)}
              >
                <span>
                  {location && <small className="project-path">{location}</small>}
                  {project.title}
                </span>
                <ArrowRight size={16} />
              </button>
              <button
                className="icon-button"
                aria-label={favorite ? "Quitar de favoritos" : "Añadir a favoritos"}
                onClick={() => toggleFavorite(project.id)}
              >
                <Star size={16} fill={favorite ? "currentColor" : "none"} />
              </button>
            </div>
            {project.data.description && <p>{project.data.description}</p>}
            <div className="project-progress">
              <div className="progress-track">
                <span style={{ width: `${s.percent}%` }} />
              </div>
              <div className="project-footer">
                <span>
                  {s.done} de {s.total} tareas
                  {!needle && subprojects > 0 &&
                    ` · ${subprojects} ${subprojects === 1 ? "subproyecto" : "subproyectos"}`}
                </span>
                <span>{s.percent}%</span>
              </div>
            </div>
            {!needle && subtree(project.id)}
            <div className="project-card-links">
              <button className="text-button" onClick={() => showDetails(project)}>
                Detalles del proyecto
              </button>
              {canManage(project) && (
                <>
                  <button className="text-button" onClick={() => configureFields(project)}>
                    Campos de tareas
                  </button>
                  <button className="text-button" onClick={() => configureWorkflow(project)}>
                    Flujo de estados
                  </button>
                </>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/** Parent and children between projects, skipping folders in between. */
export function projectTree(projects: Resource[], resources: Resource[]) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const projectIds = new Set(projects.map((p) => p.id));
  const parent = new Map<string, Resource | null>();
  for (const project of projects) {
    let cursor = project.data.parentId as string | null | undefined;
    const seen = new Set<string>();
    while (cursor && !projectIds.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const r = byId.get(cursor);
      cursor = r ? r.data.parentId || r.data.projectId : null;
    }
    parent.set(project.id, cursor && cursor !== project.id ? byId.get(cursor) || null : null);
  }
  const byTitle = (a: Resource, b: Resource) => a.title.localeCompare(b.title);
  return {
    parentOf: (id: string) => parent.get(id) || null,
    childrenOf: (id: string) =>
      projects.filter((p) => parent.get(p.id)?.id === id).sort(byTitle),
    roots: () => projects.filter((p) => !parent.get(p.id)).sort(byTitle),
  };
}
