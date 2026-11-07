import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Info,
  Plus,
  SlidersHorizontal,
  Star,
  Workflow,
} from "lucide-react";
import { sprintStats, type Resource } from "../shared/model";

/**
 * The projects page. Favorites sit on top as cards; below, every project as a compact tree
 * (subprojects nested, progress counted over the whole branch). New projects and subprojects
 * are created in place. A search shows matches flat, each with its path.
 */
export function ProjectList({
  projects,
  resources,
  tasks,
  query,
  favorites,
  canEdit,
  toggleFavorite,
  openProject,
  showDetails,
  canManage,
  configureFields,
  configureWorkflow,
  createProject,
}: {
  projects: Resource[];
  resources: Resource[];
  tasks: Resource[];
  query: string;
  favorites: string[];
  canEdit: boolean;
  toggleFavorite: (id: string) => void;
  openProject: (id: string) => void;
  showDetails: (project: Resource) => void;
  canManage: (project: Resource) => boolean;
  configureFields: (project: Resource) => void;
  configureWorkflow: (project: Resource) => void;
  createProject: (title: string, parentId: string | null) => Promise<unknown>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null | undefined>(undefined);
  const tree = projectTree(projects, resources);
  const today = new Date().toLocaleDateString("en-CA");
  const branch = (id: string, depth = 0): string[] =>
    depth > 16 ? [] : [id, ...tree.childrenOf(id).flatMap((c) => branch(c.id, depth + 1))];
  const summary = (id: string) => {
    const ids = new Set(branch(id));
    const own = tasks.filter((t) => ids.has(t.data.projectId));
    const late = own.filter(
      (t) => t.data.dueDate && t.data.dueDate < today && !["done", "cancelled"].includes(t.data.status),
    ).length;
    return { ...sprintStats(own), late };
  };
  const path = (project: Resource) => {
    const names: string[] = [];
    for (let p = tree.parentOf(project.id); p && names.length < 16; p = tree.parentOf(p.id))
      names.unshift(p.title);
    return names.join(" › ");
  };
  const needle = query.trim().toLowerCase();
  const pinned = favorites
    .map((id) => projects.find((p) => p.id === id))
    .filter(Boolean) as Resource[];

  const row = (project: Resource, depth: number, location = ""): React.ReactNode => {
    const s = summary(project.id);
    const children = needle ? [] : tree.childrenOf(project.id);
    const open = !collapsed.has(project.id);
    const favorite = favorites.includes(project.id);
    return (
      <li key={project.id}>
        <div className="project-row" style={{ paddingInlineStart: 8 + depth * 22 }}>
          {children.length ? (
            <button
              className="project-row-toggle"
              aria-label={`${open ? "Contraer" : "Expandir"} ${project.title}`}
              aria-expanded={open}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  next.has(project.id) ? next.delete(project.id) : next.add(project.id);
                  return next;
                })
              }
            >
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          ) : (
            <span className="project-row-toggle" />
          )}
          <span className="project-dot" style={{ background: project.data.color || "var(--accent)" }} />
          <button className="project-row-name" onClick={() => openProject(project.id)}>
            {location && <small>{location}</small>}
            <span>{project.title}</span>
          </button>
          <span className="project-row-progress" title={`${s.percent}% completado`}>
            <span className="progress-track">
              <span style={{ width: `${s.percent}%` }} />
            </span>
            <small>
              {s.done}/{s.total}
            </small>
          </span>
          <span className={`project-row-late ${s.late ? "has-late" : ""}`}>
            {s.late ? `${s.late} vencida${s.late === 1 ? "" : "s"}` : ""}
          </span>
          <span className="project-row-actions">
            <button
              className="icon-button"
              aria-label={favorite ? "Quitar de favoritos" : "Añadir a favoritos"}
              title={favorite ? "Quitar de favoritos" : "Añadir a favoritos"}
              aria-pressed={favorite}
              onClick={() => toggleFavorite(project.id)}
            >
              <Star size={15} fill={favorite ? "currentColor" : "none"} />
            </button>
            {canEdit && (
              <button
                className="icon-button"
                aria-label={`Nuevo subproyecto en ${project.title}`}
                title="Nuevo subproyecto"
                onClick={() => setAdding(project.id)}
              >
                <Plus size={15} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Detalles del proyecto"
              title="Detalles del proyecto"
              onClick={() => showDetails(project)}
            >
              <Info size={15} />
            </button>
            {canManage(project) && (
              <>
                <button
                  className="icon-button"
                  aria-label="Campos de tareas"
                  title="Campos de tareas"
                  onClick={() => configureFields(project)}
                >
                  <SlidersHorizontal size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Flujo de estados"
                  title="Flujo de estados"
                  onClick={() => configureWorkflow(project)}
                >
                  <Workflow size={15} />
                </button>
              </>
            )}
          </span>
        </div>
        {(open && children.length > 0) || adding === project.id ? (
          <ul>
            {open && children.map((child) => row(child, depth + 1))}
            {adding === project.id && (
              <NewProjectRow
                depth={depth + 1}
                label={`Nombre del subproyecto en ${project.title}`}
                cancel={() => setAdding(undefined)}
                create={(title) => createProject(title, project.id)}
              />
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  const shown = needle
    ? projects.filter((p) => p.title.toLowerCase().includes(needle))
    : tree.roots();
  return (
    <div className="project-page">
      {!needle && pinned.length > 0 && (
        <section aria-label="Proyectos favoritos" className="project-favorites">
          {pinned.map((project) => {
            const s = summary(project.id);
            return (
              <button key={project.id} className="project-favorite" onClick={() => openProject(project.id)}>
                <span className="project-dot" style={{ background: project.data.color || "var(--accent)" }} />
                <strong>{project.title}</strong>
                <span className="progress-track">
                  <span style={{ width: `${s.percent}%` }} />
                </span>
                <small>
                  {s.done} de {s.total} tareas{s.late ? ` · ${s.late} vencidas` : ""}
                </small>
              </button>
            );
          })}
        </section>
      )}
      <section aria-label="Todos los proyectos" className="project-list">
        <div className="project-list-head" aria-hidden="true">
          <span className="project-list-head-name">Proyecto</span>
          <span>Progreso</span>
          <span>Vencidas</span>
          <span />
        </div>
        <ul>
          {shown.map((project) => row(project, 0, needle ? path(project) : ""))}
          {canEdit && !needle && (
            adding === null ? (
              <NewProjectRow
                depth={0}
                label="Nombre del nuevo proyecto"
                cancel={() => setAdding(undefined)}
                create={(title) => createProject(title, null)}
              />
            ) : (
              <li>
                <button className="project-row-add" onClick={() => setAdding(null)}>
                  <Plus size={15} /> Añadir proyecto
                </button>
              </li>
            )
          )}
        </ul>
        {needle && !shown.length && <p className="project-list-empty">Ningún proyecto coincide.</p>}
      </section>
    </div>
  );
}

/** Inline name field: Enter creates, Escape cancels. Stays open to add several in a row. */
function NewProjectRow({
  depth,
  label,
  cancel,
  create,
}: {
  depth: number;
  label: string;
  cancel: () => void;
  create: (title: string) => Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await create(value);
      setTitle("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <form
        className="project-row project-row-new"
        style={{ paddingInlineStart: 8 + depth * 22 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span className="project-row-toggle" />
        <Plus size={15} />
        <input
          autoFocus
          aria-label={label}
          placeholder="Nombre del proyecto y Enter"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && cancel()}
        />
        <button type="submit" className="primary" disabled={!title.trim() || busy}>
          Crear
        </button>
        <button type="button" className="secondary" onClick={cancel}>
          Cancelar
        </button>
      </form>
    </li>
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
    childrenOf: (id: string) => projects.filter((p) => parent.get(p.id)?.id === id).sort(byTitle),
    roots: () => projects.filter((p) => !parent.get(p.id)).sort(byTitle),
  };
}
