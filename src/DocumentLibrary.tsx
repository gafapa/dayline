import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, Plus } from "lucide-react";
import type { Resource } from "../shared/model";
import { documentText } from "../shared/documents";
import { structureParent } from "../shared/hierarchy";
import { projectTree } from "./ProjectList";
import { SearchField } from "./ui-common";

type Place = { kind: "all" | "recent" | "shared" } | { kind: "project" | "folder"; id: string };
const short = (iso: string) =>
  new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(iso));

/**
 * Team documents as a library: projects and folders on the left, the chosen place on the
 * right with a search, an order and one row per document (where it lives, an excerpt, who
 * and when). A new document is created in place, inside the folder or project shown.
 */
export default function DocumentLibrary({
  resources,
  members,
  projectId,
  canEdit,
  open,
  create,
  userId,
  fromTemplate,
}: {
  userId: string;
  fromTemplate?: () => void;
  resources: Resource[];
  members: { id: string; name: string }[];
  projectId: string | null;
  canEdit: boolean;
  open: (resource: Resource) => void;
  create: (title: string, data: Record<string, any>) => Promise<unknown>;
}) {
  const [place, setPlace] = useState<Place>(projectId ? { kind: "project", id: projectId } : { kind: "all" });
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"recent" | "name">("recent");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(projectId ? [projectId] : []));
  const [draft, setDraft] = useState("");
  const byId = new Map(resources.map((r) => [r.id, r]));
  const projects = resources.filter((r) => r.kind === "project");
  const folders = resources.filter((r) => r.kind === "folder");
  const documents = resources.filter((r) => r.kind === "document" && !r.data.personalNote);
  const tree = projectTree(projects, resources);
  /** Someone else's document that names you as member, follower or reviewer. */
  const sharedWithMe = (d: Resource) =>
    d.created_by !== userId &&
    [...(d.data.members || []), ...(d.data.followers || []), ...(d.data.reviewers || [])].includes(userId);
  /** The task a document is linked to, either way round. */
  const linkedTask = (d: Resource) =>
    resources.find(
      (r) =>
        r.kind === "task" &&
        ((d.data.related || []).includes(r.id) || (r.data.related || []).includes(d.id)),
    );
  const within = (doc: Resource, id: string) => {
    for (let cursor = structureParent(doc), n = 0; cursor && n < 64; n++) {
      if (cursor === id) return true;
      cursor = structureParent(byId.get(cursor) || ({ data: {} } as Resource));
    }
    return false;
  };
  const scoped = documents.filter((d) =>
    place.kind === "project"
      ? d.data.projectId === place.id
      : place.kind === "folder"
        ? within(d, place.id)
        : place.kind === "shared"
          ? sharedWithMe(d)
          : true,
  );
  const needle = query.trim().toLowerCase();
  const shown = scoped
    .map((d) => ({ d, text: documentText(d.data.content) }))
    .filter(({ d, text }) => !needle || `${d.title} ${text}`.toLowerCase().includes(needle))
    .sort((a, b) =>
      order === "name" ? a.d.title.localeCompare(b.d.title) : b.d.updated_at.localeCompare(a.d.updated_at),
    )
    .slice(0, place.kind === "recent" ? 15 : 500);
  const countIn = (id: string, kind: "project" | "folder") =>
    documents.filter((d) => (kind === "project" ? d.data.projectId === id : within(d, id))).length;
  const location = (d: Resource) => {
    const parent = byId.get(structureParent(d) || "");
    const project = byId.get(d.data.projectId);
    return parent && parent.id !== project?.id ? `${project?.title || ""} › ${parent.title}` : project?.title || "Sin proyecto";
  };
  const excerpt = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!needle) return clean.slice(0, 140);
    const at = clean.toLowerCase().indexOf(needle);
    return at < 0 ? clean.slice(0, 140) : `${at > 40 ? "…" : ""}${clean.slice(Math.max(0, at - 40), at + 100)}`;
  };
  const author = (d: Resource) => members.find((m) => m.id === d.created_by)?.name || "";
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const current =
    place.kind === "project" || place.kind === "folder" ? byId.get(place.id) : undefined;
  const target =
    place.kind === "folder"
      ? { projectId: current?.data.projectId, parentId: place.id }
      : place.kind === "project"
        ? { projectId: place.id, parentId: place.id }
        : {};
  const placeTitle = current
    ? place.kind === "folder"
      ? `${byId.get(current.data.projectId)?.title || ""} › ${current.title}`
      : current.title
    : place.kind === "recent"
      ? "Recientes"
      : place.kind === "shared"
        ? "Compartidos conmigo"
      : "Todos los documentos";

  const folderNodes = (parentId: string, depth: number): React.ReactNode =>
    folders
      .filter((f) => structureParent(f) === parentId)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((f) => (
        <li key={f.id}>
          <button
            className="library-node"
            style={{ paddingInlineStart: 8 + depth * 16 }}
            aria-current={place.kind === "folder" && place.id === f.id ? "true" : undefined}
            onClick={() => setPlace({ kind: "folder", id: f.id })}
          >
            <span className="library-toggle" />
            <Folder size={14} />
            <span>{f.title}</span>
            <small>{countIn(f.id, "folder")}</small>
          </button>
          {depth < 6 && <ul>{folderNodes(f.id, depth + 1)}</ul>}
        </li>
      ));
  const projectNode = (p: Resource, depth: number): React.ReactNode => {
    const children = tree.childrenOf(p.id);
    const hasFolders = folders.some((f) => structureParent(f) === p.id);
    const isOpen = expanded.has(p.id);
    return (
      <li key={p.id}>
        <div className="library-row" style={{ paddingInlineStart: depth * 16 }}>
          {children.length || hasFolders ? (
            <button
              className="library-toggle"
              aria-label={`${isOpen ? "Contraer" : "Expandir"} ${p.title}`}
              aria-expanded={isOpen}
              onClick={() => toggle(p.id)}
            >
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className="library-toggle" />
          )}
          <button
            className="library-node"
            aria-current={place.kind === "project" && place.id === p.id ? "true" : undefined}
            onClick={() => setPlace({ kind: "project", id: p.id })}
          >
            <span className="project-dot" style={{ background: p.data.color || "var(--accent)" }} />
            <span>{p.title}</span>
            <small>{countIn(p.id, "project")}</small>
          </button>
        </div>
        {isOpen && (
          <ul>
            {folderNodes(p.id, depth + 1)}
            {depth < 4 && children.map((c) => projectNode(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="library">
      <nav className="library-tree" aria-label="Carpetas">
        <button
          className="library-node"
          aria-current={place.kind === "all" ? "true" : undefined}
          onClick={() => setPlace({ kind: "all" })}
        >
          <span>Todos</span>
          <small>{documents.length}</small>
        </button>
        <button
          className="library-node"
          aria-current={place.kind === "recent" ? "true" : undefined}
          onClick={() => setPlace({ kind: "recent" })}
        >
          <span>Recientes</span>
        </button>
        <button
          className="library-node"
          aria-current={place.kind === "shared" ? "true" : undefined}
          onClick={() => setPlace({ kind: "shared" })}
        >
          <span>Compartidos conmigo</span>
          <small>{documents.filter(sharedWithMe).length}</small>
        </button>
        <p className="library-label">Proyectos</p>
        <ul>{tree.roots().map((p) => projectNode(p, 0))}</ul>
      </nav>
      <div className="library-main">
        <div className="page-toolbar">
          <span className="library-place">{placeTitle}</span>
          <SearchField value={query} set={setQuery} />
          <div className="segmented push-end" role="group" aria-label="Orden de los documentos">
            <button aria-pressed={order === "recent"} onClick={() => setOrder("recent")}>
              Recientes
            </button>
            <button aria-pressed={order === "name"} onClick={() => setOrder("name")}>
              A–Z
            </button>
          </div>
          {canEdit && fromTemplate && <button onClick={fromTemplate}>Desde plantilla</button>}
        </div>
        {place.kind === "all" && !needle && shown.length > 3 && (
          <section className="library-continue" aria-label="Seguir leyendo">
            {[...shown]
              .sort((a, b) => b.d.updated_at.localeCompare(a.d.updated_at))
              .slice(0, 3)
              .map(({ d, text }) => (
                <button key={d.id} className="library-card" onClick={() => open(d)}>
                  <strong>{d.title}</strong>
                  {text.trim() && <span>{excerpt(text)}</span>}
                  <small>
                    Editado {short(d.updated_at)}
                    {author(d) ? ` por ${author(d)}` : ""}
                  </small>
                </button>
              ))}
          </section>
        )}
        <section className="library-list" aria-label="Documentos">
          {shown.length > 0 && (
            <div className="document-row document-head" aria-hidden="true">
              <span />
              <span>Nombre</span>
              <span>Vinculado a</span>
              <span>Autor</span>
              <span>Actualizado</span>
            </div>
          )}
          {shown.map(({ d, text }) => (
            <button key={d.id} className="document-row" onClick={() => open(d)}>
              <FileText size={18} />
              <span className="document-row-main">
                <strong>{d.title}</strong>
                {text.trim() && <small className="document-excerpt">{excerpt(text)}</small>}
              </span>
              <small className="document-place">{linkedTask(d)?.title || location(d)}</small>
              <small className="document-author">{author(d)}</small>
              <small className="document-date">{short(d.updated_at)}</small>
            </button>
          ))}
          {!shown.length && (
            <p className="muted library-empty">
              {needle ? "Ningún documento coincide." : "Aquí todavía no hay documentos."}
            </p>
          )}
          {canEdit && !["recent", "shared"].includes(place.kind) && (
            <form
              className="library-add"
              onSubmit={async (e) => {
                e.preventDefault();
                const title = draft.trim();
                if (!title) return;
                await create(title, target);
                setDraft("");
              }}
            >
              <Plus size={16} />
              <input
                aria-label={`Documento nuevo en ${placeTitle}`}
                placeholder={`Documento nuevo en ${placeTitle}… escribe el título y pulsa Enter`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
