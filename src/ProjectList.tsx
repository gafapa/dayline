import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Info,
  Plus,
  SlidersHorizontal,
  Star,
  Workflow,
} from "lucide-react";
import { sprintStats, type Resource } from "../shared/model";
import { structureBranch, structureParent } from "../shared/hierarchy";
import { placeInOrder, useDrag, useDrop, type DragItem } from "./dnd";

/**
 * The projects page. Favorites sit on top as cards; below, every project as a compact tree
 * (subprojects nested, progress counted over the whole branch). New projects and subprojects
 * are created in place. A search shows matches flat, each with its path.
 * Drag a project by its grip: onto another project to nest it (a reviewed move), onto the
 * gap between two siblings to reorder, or onto the header to take it back to the top level.
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
  save,
  move,
}: {
  save: (project: Resource) => Promise<unknown>;
  move: (project: Resource, destinationId: string | null) => void;
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
  const dragged = (item: DragItem) =>
    canEdit && item.type === "structure" && item.resource.kind === "project" ? item.resource : null;
  const siblings = (parentId: string | null) => (parentId ? tree.childrenOf(parentId) : tree.roots());
  /** Gap before `beforeId` (or at the end) among the children of `parentId`. */
  const gap = (parentId: string | null, beforeId: string | null, depth: number) => (
    <ProjectGap
      key={`gap:${parentId}:${beforeId}`}
      id={`project-gap:${parentId}:${beforeId}`}
      depth={depth}
      accepts={(item) => {
        const p = dragged(item);
        return !!p && p.id !== beforeId && (tree.parentOf(p.id)?.id || null) === parentId;
      }}
      drop={async (item) => {
        const p = dragged(item);
        if (!p) return;
        const list = siblings(parentId);
        const changes = placeInOrder(list, p, beforeId);
        for (const r of list) {
          const order = changes.get(r.id);
          if (order !== undefined) await save({ ...r, data: { ...r.data, order } });
        }
      }}
    />
  );
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
        <ProjectRow
          project={project}
          depth={depth}
          canDrag={canEdit && !needle}
          accepts={(item) => {
            const p = dragged(item);
            return (
              !!p &&
              p.id !== project.id &&
              structureParent(p) !== project.id &&
              !structureBranch(p.id, resources).some((r) => r.id === project.id)
            );
          }}
          drop={(item) => {
            const p = dragged(item);
            if (p) move(p, project.id);
          }}
        >
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
        </ProjectRow>
        {(open && children.length > 0) || adding === project.id ? (
          <ul>
            {open && children.flatMap((child) => [gap(project.id, child.id, depth + 1), row(child, depth + 1)])}
            {open && children.length > 0 && gap(project.id, null, depth + 1)}
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
        <ProjectRoot
          accepts={(item) => {
            const p = dragged(item);
            return !!p && structureParent(p) !== null;
          }}
          drop={(item) => {
            const p = dragged(item);
            if (p) move(p, null);
          }}
        />
        <ul>
          {needle
            ? shown.map((project) => row(project, 0, path(project)))
            : shown.flatMap((project) => [gap(null, project.id, 0), row(project, 0)])}
          {!needle && shown.length > 0 && gap(null, null, 0)}
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

type Target = { accepts: (item: DragItem) => boolean; drop: (item: DragItem) => void | Promise<unknown> };

/** A project row with its grip; dropping another project on it nests that project inside. */
function ProjectRow({
  project,
  depth,
  canDrag,
  accepts,
  drop: onDrop,
  children,
}: Target & { project: Resource; depth: number; canDrag: boolean; children: ReactNode }) {
  const drag = useDrag(
    `project-row:${project.id}`,
    { type: "structure", resource: project, label: project.title },
    !canDrag,
  );
  const drop = useDrop(`project-into:${project.id}`, { accepts, drop: onDrop });
  return (
    <div
      ref={(node) => {
        drag.ref(node);
        drop.ref(node);
      }}
      className={`project-row ${drag.dragging ? "dragging" : ""} ${drop.over ? "drop-over" : ""}`}
      style={{ paddingInlineStart: 26 + depth * 22 }}
    >
      {canDrag && (
        <button
          className="drag-grip project-row-grip"
          aria-label={`Arrastrar ${project.title}`}
          title="Arrastra para ordenar, o suelta sobre otro proyecto para meterlo dentro"
          {...drag.handle}
        >
          <GripVertical size={14} />
        </button>
      )}
      {children}
    </div>
  );
}

/** The space between two sibling rows: it opens while a sibling is dragged, to reorder. */
function ProjectGap({ id, depth, accepts, drop: onDrop }: Target & { id: string; depth: number }) {
  const drop = useDrop(id, { accepts, drop: onDrop });
  return (
    <li
      ref={drop.ref}
      aria-hidden="true"
      className={`project-gap ${drop.armed ? "drop-armed" : ""} ${drop.over ? "drop-over" : ""}`}
      style={{ marginInlineStart: 26 + depth * 22 }}
    />
  );
}

/** The list header; dropping a subproject on it takes it to the top level. */
function ProjectRoot({ accepts, drop: onDrop }: Target) {
  const drop = useDrop("project-root", { accepts, drop: onDrop });
  return (
    <div
      ref={drop.ref}
      className={`project-list-head ${drop.armed ? "drop-armed" : ""} ${drop.over ? "drop-over" : ""}`}
    >
      {drop.armed ? (
        <span className="project-list-head-name">Suelta aquí para llevarlo al nivel superior</span>
      ) : (
        <>
          <span className="project-list-head-name" aria-hidden="true">Proyecto</span>
          <span aria-hidden="true">Progreso</span>
          <span aria-hidden="true">Vencidas</span>
          <span />
        </>
      )}
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
        style={{ paddingInlineStart: 26 + depth * 22 }}
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
  // Projects someone has ordered by dragging come first, in that order; the rest by name.
  const rank = (r: Resource) => (typeof r.data.order === "number" ? r.data.order : Number.MAX_VALUE);
  const byTitle = (a: Resource, b: Resource) => rank(a) - rank(b) || a.title.localeCompare(b.title);
  return {
    parentOf: (id: string) => parent.get(id) || null,
    childrenOf: (id: string) => projects.filter((p) => parent.get(p.id)?.id === id).sort(byTitle),
    roots: () => projects.filter((p) => !parent.get(p.id)).sort(byTitle),
  };
}
