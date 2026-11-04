import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useDrag, useDrop, type DragItem } from "./dnd";
import {
  Folder,
  FolderKanban,
  FileText,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  GripVertical,
} from "lucide-react";
import type { Resource, ResourceKind, User, Workspace } from "../shared/model";
import { kindLabels } from "../shared/model";
import {
  acceptsChild,
  isStructure,
  structureParent,
  structurePath,
  structureBranch,
  projectAt,
  type MovePreview,
} from "../shared/hierarchy";
import { Field, Modal } from "./components/Primitives";
import { api, send } from "./api";
import { useServerCommand } from "./useServerCommand";
import { useSprintDraft } from "./useSprintDraft";
type StructureKind = "folder" | "project" | "document";
type Props = {
  resources: Resource[];
  workspace: Workspace;
  user: User;
  canEdit: boolean;
  focusId: string | null;
  setFocus: (id: string | null) => void;
  open: (r: Resource) => void;
  openTasks: (id: string) => void;
  configureFields: (project: Resource) => void;
  configureWorkflow: (project: Resource) => void;
  create: (
    kind: ResourceKind,
    title: string,
    data: Record<string, any>,
  ) => Promise<Resource | undefined>;
  save: (r: Resource) => Promise<Resource | undefined>;
  refresh: () => Promise<void>;
};
const icon = (kind: ResourceKind) =>
  kind === "folder" ? Folder : kind === "project" ? FolderKanban : FileText;
const pathName = (r: Resource, all: Resource[]) => {
  try {
    return structurePath(r.id, all)
      .map((p) => p.title)
      .join(" / ");
  } catch {
    return r.title;
  }
};
export default function ProjectStructure(props: Props) {
  const [treeVisible, setTreeVisible] = useState(
    () => matchMedia("(min-width: 761px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(min-width: 761px)");
    const change = () => setTreeVisible(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const {
    resources,
    workspace,
    user,
    canEdit,
    focusId,
    setFocus,
    open,
    create,
    save,
    refresh,
  } = props;
  const [query, setQuery] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [creating, setCreating] = useState<StructureKind | null>(null),
    [moving, setMoving] = useState<Resource | null>(null),
    [moveTo, setMoveTo] = useState<string | null | undefined>(undefined),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [expanded, setExpanded] = useState<Set<string>>(new Set());
  const structure = useMemo(
    () =>
      resources.filter(
        (r) =>
          isStructure(r) && !r.deleted_at && (showArchived || !r.data.archived),
      ),
    [resources, showArchived],
  );
  const focus = structure.find((r) => r.id === focusId),
    currentId = focus?.id || null;
  const childrenByParent = useMemo(() => {
    const groups = new Map<string | null, Resource[]>();
    for (const resource of structure) {
      const parent = structureParent(resource);
      const group = groups.get(parent) || [];
      group.push(resource);
      groups.set(parent, group);
    }
    return groups;
  }, [structure]);
  const path = focus ? structurePath(focus.id, resources) : [];
  const children = structure
    .filter((r) =>
      query
        ? r.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        : structureParent(r) === currentId,
    )
    .sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title),
    );
  const command = useServerCommand(
    user.id,
    workspace.id,
    "hierarchy",
    async () => {
      await refresh();
      setMoving(null);
      setNotice("Movimiento confirmado. La estructura se ha actualizado.");
    },
  );
  const select = (id: string | null) => {
    setQuery("");
    setFocus(id);
  };
  const tree = (
    parent: string | null,
    depth = 0,
    seen = new Set<string>(),
  ): React.ReactNode => {
    if (depth >= 128) return null;
    return (
      <ul>
        {(childrenByParent.get(parent) || [])
          .filter((r) => r.kind !== "document" && !seen.has(r.id))
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((r) => {
            const Icon = icon(r.kind),
              hasChildren = (childrenByParent.get(r.id) || []).some(
                (c) => c.kind !== "document",
              ),
              isExpanded =
                expanded.has(r.id) || path.some((p) => p.id === r.id);
            return (
              <li key={r.id}>
                <div
                  className="structure-tree-row"
                  style={{ paddingInlineStart: Math.min(depth, 6) * 10 }}
                >
                  {hasChildren ? (
                    <button
                      className="icon-button"
                      aria-label={`${isExpanded ? "Contraer" : "Expandir"} ${r.title}`}
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                          return next;
                        })
                      }
                    >
                      {isExpanded ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronRight size={15} />
                      )}
                    </button>
                  ) : (
                    <span className="structure-tree-spacer" />
                  )}
                  <DropZone id={`tree:${r.id}`} target={target(r)}>
                    <button
                      className="structure-location"
                      aria-current={r.id === currentId ? "location" : undefined}
                      onClick={() => select(r.id)}
                    >
                      <Icon size={16} />
                      <span title={r.title}>{r.title}</span>
                    </button>
                  </DropZone>
                </div>
                {hasChildren && isExpanded
                  ? tree(r.id, depth + 1, new Set([...seen, r.id]))
                  : null}
              </li>
            );
          })}
      </ul>
    );
  };
  /** Opens the reviewed move with the destination already chosen. */
  const dropOn = (item: DragItem, destinationId: string | null) => {
    if (item.type !== "structure") return;
    setMoveTo(destinationId);
    setMoving(item.resource);
  };
  const accepts = (item: DragItem, target: Resource | null) =>
    canEdit &&
    item.type === "structure" &&
    !item.resource.data.archived &&
    (structureParent(item.resource) || null) !== (target?.id || null) &&
    (!target ||
      (target.id !== item.resource.id &&
        !target.data.archived &&
        !structureBranch(item.resource.id, resources).some((r) => r.id === target.id) &&
        acceptsChild(target.kind, item.resource.kind)));
  const target = (r: Resource | null) => ({
    accepts: (item: DragItem) => accepts(item, r),
    drop: (item: DragItem) => dropOn(item, r?.id || null),
  });
  return (
    <section className="project-structure" aria-label="Estructura de proyectos">
      {command.recovery}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="structure-layout">
        <details
          className="structure-navigation-shell"
          open={treeVisible}
          onToggle={(event) => setTreeVisible(event.currentTarget.open)}
        >
          <summary>Ubicaciones</summary>
          <nav
            aria-label="Carpetas y subproyectos"
            className="structure-navigation"
          >
            <DropZone id="tree-root" target={target(null)}>
              <button
                className="structure-root"
                aria-current={!currentId ? "location" : undefined}
                onClick={() => select(null)}
              >
                {workspace.name}
              </button>
            </DropZone>
            {tree(null)}
          </nav>
        </details>
        <div className="structure-content">
          <nav
            aria-label="Ruta de la estructura"
            className="structure-breadcrumb"
          >
            <DropZone id="crumb-root" target={target(null)}>
              <button onClick={() => select(null)}>Raíz</button>
            </DropZone>
            {path.map((r) => (
              <span key={r.id}>
                <ChevronRight size={14} />
                <DropZone id={`crumb:${r.id}`} target={target(r)}>
                  <button
                    onClick={() => select(r.id)}
                    aria-current={r.id === currentId ? "location" : undefined}
                  >
                    {r.title}
                  </button>
                </DropZone>
              </span>
            ))}
          </nav>
          <div className="section-heading">
            <div>
              <h2>{focus?.title || "Carpetas, proyectos y documentos"}</h2>
              <p className="muted">
                {children.length} elementos visibles
                {query ? " en la búsqueda" : ""}
              </p>
            </div>
            {focus && (
              <div className="structure-actions">
                {focus.kind === "project" && (
                  <button onClick={() => props.openTasks(focus.id)}>
                    Tareas del proyecto
                  </button>
                )}
                {focus.kind === "project" &&
                  canEdit &&
                  (workspace.role === "admin" ||
                    focus.created_by === user.id) && (
                    <button onClick={() => props.configureFields(focus)}>
                      Campos de tareas
                    </button>
                  )}
                {focus.kind === "project" &&
                  canEdit &&
                  (workspace.role === "admin" ||
                    focus.created_by === user.id) && (
                    <button onClick={() => props.configureWorkflow(focus)}>
                      Flujo de estados
                    </button>
                  )}
                <button onClick={() => open(focus)}>Detalles</button>
              </div>
            )}
          </div>
          <div className="structure-tools">
            <Field label="Buscar en la estructura">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Nombre del proyecto, carpeta o documento"
              />
            </Field>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Mostrar archivados
            </label>
          </div>
          {canEdit && (
            <div className="structure-actions">
              {(["folder", "project", "document"] as const)
                .filter((kind) => !focus || acceptsChild(focus.kind, kind))
                .map((kind, index) => (
                  <button
                    key={kind}
                    className={index === 0 ? "primary" : "secondary"}
                    onClick={() => setCreating(kind)}
                  >
                    {kind === "folder"
                      ? "Nueva carpeta"
                      : kind === "project"
                        ? focus
                          ? "Nuevo subproyecto"
                          : "Nuevo proyecto"
                        : "Nuevo documento"}
                  </button>
                ))}
            </div>
          )}
          <div className="structure-list">
            {children.map((r) => {
              const Icon = icon(r.kind);
              return (
                <StructureItem
                  key={r.id}
                  resource={r}
                  canDrag={canEdit && !r.data.archived}
                  target={target(r)}
                >
                  <div className="structure-item-main">
                    <Icon size={18} />
                    <button
                      className="structure-name"
                      onClick={() =>
                        r.kind === "document" ? open(r) : select(r.id)
                      }
                    >
                      {r.title}
                    </button>
                    <small>
                      {kindLabels[r.kind]}
                      {r.data.archived ? " · Archivado" : ""}
                    </small>
                  </div>
                  {query && (
                    <p className="muted structure-path">
                      {pathName(r, resources)}
                    </p>
                  )}
                  <div className="structure-row-actions">
                    <button onClick={() => select(r.id)}>
                      Contenido
                      <ArrowRight size={14} />
                    </button>
                    <button onClick={() => open(r)}>Detalles</button>
                    {canEdit && (
                      <>
                        <button
                          disabled={!!r.data.archived}
                          onClick={() => setMoving(r)}
                        >
                          Mover
                        </button>
                        <button
                          onClick={() => {
                            void save({
                              ...r,
                              data: { ...r.data, archived: !r.data.archived },
                            }).catch((e) => setError(e.message));
                          }}
                        >
                          {r.data.archived ? "Desarchivar" : "Archivar"}
                        </button>
                      </>
                    )}
                  </div>
                </StructureItem>
              );
            })}
          </div>
          {!children.length && (
            <p className="structure-empty">
              {query
                ? "No hay coincidencias."
                : "Esta ubicación está vacía. Crea una carpeta, un proyecto o un documento para empezar."}
            </p>
          )}
        </div>
      </div>
      {creating && (
        <CreateStructure
          key={creating}
          kind={creating}
          resources={resources}
          user={user}
          workspace={workspace}
          parentId={currentId}
          create={create}
          close={() => setCreating(null)}
        />
      )}
      {moving && (
        <MoveStructure
          resource={moving}
          initialDestination={moveTo}
          resources={resources}
          workspace={workspace}
          ready={command.ready}
          refresh={refresh}
          close={() => {
            setMoving(null);
            setMoveTo(undefined);
          }}
          confirm={async (preview) => {
            setError("");
            await command.run(`/workspaces/${workspace.id}/hierarchy/move`, {
              id: moving.id,
              destinationId: preview.destinationId,
              fingerprint: preview.fingerprint,
            });
            await refresh();
            setMoving(null);
            setNotice(
              "Movimiento confirmado. La estructura se ha actualizado.",
            );
          }}
        />
      )}
    </section>
  );
}
function CreateStructure({
  kind,
  resources,
  user,
  workspace,
  parentId,
  create,
  close,
}: {
  kind: StructureKind;
  resources: Resource[];
  user: User;
  workspace: Workspace;
  parentId: string | null;
  create: Props["create"];
  close: () => void;
}) {
  const [value, setValue] = useState({ title: "", description: "", parentId }),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draft = useSprintDraft(
    user.id,
    `${workspace.id}:hierarchy:create:${kind}`,
    value,
    dirty,
    (data) => {
      if (
        typeof data?.title === "string" &&
        typeof data?.description === "string" &&
        (data.parentId === null || typeof data.parentId === "string")
      ) {
        setValue(data);
        setDirty(true);
      }
    },
  );
  const update = (patch: Partial<typeof value>) => {
    setValue((v) => ({ ...v, ...patch }));
    setDirty(true);
  };
  return (
    <Modal
      title={`Crear ${kindLabels[kind].toLocaleLowerCase()}`}
      close={close}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const projectId =
              kind === "project"
                ? undefined
                : projectAt(value.parentId, resources);
            await create(kind, value.title, {
              description: value.description,
              parentId: value.parentId,
              ...(kind === "project" ? { status: "active" } : { projectId }),
              ...(kind === "document"
                ? { content: { type: "doc", content: [{ type: "paragraph" }] } }
                : {}),
            });
            await draft.clear();
            close();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <p role="alert">{error}</p>}
        {draft.issue && <p role="alert">{draft.issue}</p>}
        {draft.saved && (
          <p role="status">Borrador guardado en este dispositivo.</p>
        )}
        <Field label="Título">
          <input
            autoFocus
            required
            maxLength={500}
            value={value.title}
            onChange={(e) => update({ title: e.target.value })}
          />
        </Field>
        <Field label="Descripción">
          <textarea
            rows={3}
            value={value.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </Field>
        <Field label="Ubicación">
          <select
            value={value.parentId || ""}
            onChange={(e) => update({ parentId: e.target.value || null })}
          >
            <option value="">Raíz del espacio</option>
            {resources
              .filter(
                (r) =>
                  isStructure(r) &&
                  !r.deleted_at &&
                  !r.data.archived &&
                  acceptsChild(r.kind, kind),
              )
              .map((r) => (
                <option value={r.id} key={r.id}>
                  {pathName(r, resources)}
                </option>
              ))}
          </select>
        </Field>
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cerrar
          </button>
          <button className="primary" disabled={busy || !draft.ready}>
            {busy
              ? "Guardando…"
              : `Crear ${kindLabels[kind].toLocaleLowerCase()}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function MoveStructure({
  resource,
  initialDestination,
  resources,
  workspace,
  ready,
  refresh,
  close,
  confirm,
}: {
  resource: Resource;
  initialDestination?: string | null;
  resources: Resource[];
  workspace: Workspace;
  ready: boolean;
  refresh: Props["refresh"];
  close: () => void;
  confirm: (preview: MovePreview) => Promise<void>;
}) {
  const [destination, setDestination] = useState(
      initialDestination !== undefined
        ? initialDestination || ""
        : structureParent(resource) || "",
    ),
    [preview, setPreview] = useState<MovePreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const excluded = new Set(
    structureBranch(resource.id, resources).map((r) => r.id),
  );
  useEffect(() => {
    if (initialDestination === undefined || !navigator.onLine) return;
    let current = true;
    setBusy(true);
    api<MovePreview>(
      `/workspaces/${workspace.id}/hierarchy/preview`,
      send({ id: resource.id, destinationId: initialDestination || null }),
    )
      .then((value) => current && setPreview(value))
      .catch((e) => current && setError((e as Error).message))
      .finally(() => current && setBusy(false));
    return () => {
      current = false;
    };
  }, []);
  return (
    <Modal title={`Mover ${resource.title}`} close={close}>
      <div className="modal-body">
        <p>
          El movimiento conserva los documentos y actualiza juntos su ubicación
          y proyecto. Se aplicarán los permisos de la nueva ubicación.
        </p>
        {error && <p role="alert">{error}</p>}
        <Field label="Nueva ubicación">
          <select
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Raíz del espacio</option>
            {resources
              .filter(
                (r) =>
                  isStructure(r) &&
                  !r.deleted_at &&
                  !r.data.archived &&
                  !excluded.has(r.id) &&
                  acceptsChild(r.kind, resource.kind),
              )
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {pathName(r, resources)}
                </option>
              ))}
          </select>
        </Field>
        {preview && (
          <div className="structure-preview" role="status">
            <p>
              {preview.title} → {preview.destinationTitle}
            </p>
            <p>
              {preview.affectedCount} elementos en la estructura;{" "}
              {preview.changes.length} cambios de ubicación o proyecto.
            </p>
            <p>
              El contenido puede ser visible para otras personas en el destino.
              Las revisiones del documento siguen los permisos del destino.
            </p>
          </div>
        )}
        {!navigator.onLine && (
          <p>Conéctate para revisar y confirmar este movimiento.</p>
        )}
        <div className="form-actions">
          <button onClick={close}>Cancelar</button>
          <button
            className="primary"
            disabled={busy || !navigator.onLine || !ready}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                if (preview) await confirm(preview);
                else {
                  await refresh();
                  setPreview(
                    await api(
                      `/workspaces/${workspace.id}/hierarchy/preview`,
                      send({
                        id: resource.id,
                        destinationId: destination || null,
                      }),
                    ),
                  );
                }
              } catch (e) {
                setPreview(null);
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? "Comprobando…"
              : preview
                ? "Confirmar movimiento"
                : "Revisar movimiento"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Wraps a location so structure items can be dropped on it. */
function DropZone({
  id,
  target,
  children,
}: {
  id: string;
  target: { accepts: (item: DragItem) => boolean; drop: (item: DragItem) => void };
  children: ReactNode;
}) {
  const drop = useDrop(id, target);
  return (
    <span ref={drop.ref} className={`drop-zone ${drop.over ? "drop-over" : ""} ${drop.armed ? "drop-armed" : ""}`}>
      {children}
    </span>
  );
}
/** A structure row: drag it by its grip onto a folder, project, the path or the root. */
function StructureItem({
  resource,
  canDrag,
  target,
  children,
}: {
  resource: Resource;
  canDrag: boolean;
  target: { accepts: (item: DragItem) => boolean; drop: (item: DragItem) => void };
  children: ReactNode;
}) {
  const drag = useDrag(
    `structure:${resource.id}`,
    { type: "structure", resource, label: resource.title },
    !canDrag,
  );
  const drop = useDrop(`structure-into:${resource.id}`, target);
  return (
    <article
      ref={(node) => {
        drag.ref(node);
        drop.ref(node);
      }}
      className={`structure-item ${drag.dragging ? "dragging" : ""} ${drop.over ? "drop-over" : ""}`}
      data-resource-id={resource.id}
    >
      {canDrag && (
        <button
          className="drag-grip"
          aria-label={`Arrastrar ${resource.title}`}
          title="Arrastra sobre una carpeta, un proyecto o la ruta para moverlo"
          {...drag.handle}
        >
          <GripVertical size={15} />
        </button>
      )}
      {children}
    </article>
  );
}
