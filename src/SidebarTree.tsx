import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import type { Resource } from "../shared/model";
import { projectTree } from "./ProjectList";
import { useDrop } from "./dnd";

const storageKey = "dayline.sidebarTree";

/**
 * The workspace's projects as a tree in the sidebar: subprojects fold under their parent, each
 * row shows its colour and how much of it is done, and a task dropped on a row moves there.
 */
export function SidebarTree({
  projects,
  resources,
  tasks,
  currentId,
  canEdit,
  open,
  openAll,
  create,
  moveTask,
}: {
  projects: Resource[];
  resources: Resource[];
  tasks: Resource[];
  currentId: string | null;
  canEdit: boolean;
  open: (project: Resource) => void;
  openAll: () => void;
  create?: () => void;
  moveTask: (task: Resource, project: Resource) => Promise<void>;
}) {
  const tree = projectTree(projects, resources);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {
      return {};
    }
  });
  // The project being viewed is always visible: its ancestors open.
  useEffect(() => {
    if (!currentId) return;
    const ancestors: Record<string, boolean> = {};
    for (let p = tree.parentOf(currentId); p && Object.keys(ancestors).length < 16; p = tree.parentOf(p.id))
      ancestors[p.id] = true;
    if (Object.keys(ancestors).some((id) => !expanded[id])) setExpanded((e) => ({ ...e, ...ancestors }));
  }, [currentId]);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = { ...current, [id]: !current[id] };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {}
      return next;
    });
  const progress = (id: string) => {
    const own = tasks.filter((t) => t.data.projectId === id && t.data.status !== "cancelled");
    return own.length ? own.filter((t) => t.data.status === "done").length / own.length : null;
  };
  const rows = (list: Resource[], depth: number): ReactNode[] =>
    depth > 8
      ? []
      : list.flatMap((project) => {
          const children = tree.childrenOf(project.id);
          const isOpen = !!expanded[project.id];
          return [
            <TreeRow
              key={project.id}
              project={project}
              depth={depth}
              selected={project.id === currentId}
              hasChildren={children.length > 0}
              expanded={isOpen}
              toggle={() => toggle(project.id)}
              done={progress(project.id)}
              canEdit={canEdit}
              open={() => open(project)}
              moveTask={(task) => moveTask(task, project)}
            />,
            ...(isOpen ? rows(children, depth + 1) : []),
          ];
        });
  return (
    <div className="sidebar-tree">
      <div className="sidebar-tree-head">
        <button className="nav-group-link" onClick={openAll}>
          Proyectos
        </button>
        {create && (
          <button className="sidebar-tree-add" aria-label="Crear un proyecto nuevo" title="Crear un proyecto nuevo" onClick={create}>
            <Plus size={15} />
          </button>
        )}
      </div>
      <ul role="tree" aria-label="Proyectos">
        {rows(tree.roots(), 0)}
      </ul>
    </div>
  );
}

function TreeRow({
  project,
  depth,
  selected,
  hasChildren,
  expanded,
  toggle,
  done,
  canEdit,
  open,
  moveTask,
}: {
  project: Resource;
  depth: number;
  selected: boolean;
  hasChildren: boolean;
  expanded: boolean;
  toggle: () => void;
  done: number | null;
  canEdit: boolean;
  open: () => void;
  moveTask: (task: Resource) => Promise<void>;
}) {
  const drop = useDrop(`tree:${project.id}`, {
    accepts: (item) => item.type === "task" && canEdit && item.task.data.projectId !== project.id,
    drop: async (item) => {
      if (item.type === "task") await moveTask(item.task);
    },
  });
  const color = project.data.color || "#7c4ddb";
  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      aria-level={depth + 1}
      className="sidebar-tree-item"
    >
      <div
        ref={drop.ref}
        className={`nav-item tree-row ${selected ? "selected" : ""} ${drop.over ? "drop-over" : ""} ${drop.armed ? "drop-armed" : ""}`}
        style={{ paddingInlineStart: 4 + depth * 16 }}
      >
        {hasChildren ? (
          <button
            className="tree-toggle"
            aria-label={`${expanded ? "Plegar" : "Desplegar"} ${project.title}`}
            onClick={toggle}
          >
            <ChevronRight size={14} className={expanded ? "open" : ""} />
          </button>
        ) : (
          <span className="tree-toggle" aria-hidden="true" />
        )}
        <button
          className="tree-open"
          aria-current={selected ? "page" : undefined}
          onClick={open}
        >
          <span className={`project-dot ${depth ? "sub" : ""}`} style={{ background: depth ? "transparent" : color, borderColor: color }} />
          <span className="tree-title">{project.title}</span>
          {done !== null && (
            <span
              className="tree-progress"
              role="img"
              aria-label={`${Math.round(done * 100)}% hecho`}
            >
              <span style={{ width: `${Math.round(done * 100)}%`, background: color }} />
            </span>
          )}
        </button>
      </div>
    </li>
  );
}
