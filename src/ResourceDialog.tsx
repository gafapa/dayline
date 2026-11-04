import { useLocalGuard } from "./useLocalGuard";
import { reminderTargetKinds } from "../shared/reminders";
import { ResourceLink } from "./ResourceLink";
import { isStructure } from "../shared/hierarchy";
import { fieldDefaults, type CustomFieldValue } from "../shared/custom-fields";
import { ConfiguredTaskFields } from "./CustomFieldInputs";
import { Field, Modal } from "./components/Primitives";
import { Attachments } from "./Attachments";
import { ResourceRelations } from "./ResourceRelations";
import { AutomationFields } from "./Automations";
import { isDelivery } from "../shared/delivery";
import { canManageRule } from "../shared/automation";
import { documentMarkdown, documentText, standaloneDocument, type DocumentNode } from "../shared/documents";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, Bell, Plus, Trash2 } from "lucide-react";
import { api, send } from "./api";
import { kindLabels, statusLabels, taskStatuses, type Resource, type ResourceKind } from "../shared/model";
import WorkflowStateSelect from "./WorkflowStateSelect";
const CollaborativeEditor = lazy(() => import("./CollaborativeEditor"));
import { StatusIcon, download } from "./ui-common";
import { dateText } from "./ui-common";

const initialData = (
  kind: ResourceKind,
  projectId?: string,
): Record<string, any> => ({
  ...(["task", "project", "sprint"].includes(kind)
    ? {
        status:
          kind === "task"
            ? "backlog"
            : kind === "sprint"
              ? "planned"
              : "active",
      }
    : {}),
  ...(kind === "task"
    ? { priority: "medium", labels: [], estimate: 0, checklist: [] }
    : {}),
  ...(projectId && kind !== "project" ? { projectId } : {}),
  description: "",
});

export function CreateDialog({
  kind,
  projects,
  sprints,
  members,
  projectId,
  close,
  submit,
}: any) {
  const [busy, setBusy] = useState(false),
    [localError, setLocalError] = useState("");
  const [creationProject, setCreationProject] = useState(projectId || ""),
    [taskFields, setTaskFields] = useState<Record<string, CustomFieldValue>>(
      {},
    );
  const definitions =
    projects.find((r: Resource) => r.id === creationProject)?.data
      .fieldDefinitions || [];
  return (
    <Modal
      title={`Crear ${kindLabels[kind as ResourceKind].toLowerCase()}`}
      close={close}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          setLocalError("");
          try {
            await submit(String(f.get("title")), {
              ...initialData(kind, projectId || undefined),
              description: String(f.get("description") || ""),
              ...(f.get("projectId") ? { projectId: f.get("projectId") } : {}),
              ...(kind === "task"
                ? {
                    assigneeId: f.get("assigneeId") || null,
                    sprintId: f.get("sprintId") || null,
                    customFields: {
                      ...fieldDefaults(definitions),
                      ...taskFields,
                    },
                  }
                : {}),
              ...(kind === "sprint"
                ? {
                    goal: f.get("description"),
                    startDate: f.get("startDate") || "",
                    endDate: f.get("endDate") || "",
                  }
                : {}),
            });
          } catch (error) {
            setLocalError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {localError && <p role="alert">{localError}</p>}
        <Field label="Título">
          <input name="title" required autoFocus maxLength={500} />
        </Field>
        <Field
          label={kind === "sprint" ? "Objetivo del sprint" : "Descripción"}
        >
          <textarea name="description" rows={3} />
        </Field>
        {!["project", "team", "sprint"].includes(kind) && (
          <Field label="Proyecto">
            <select
              name="projectId"
              value={creationProject}
              onChange={(e) => {
                setCreationProject(e.target.value);
                setTaskFields({});
              }}
            >
              <option value="">Sin proyecto</option>
              {projects.map((p: Resource) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind === "task" && (
          <div className="form-grid">
            <Field label="Responsable">
              <select name="assigneeId">
                <option value="">Sin asignar</option>
                {members.map((m: any) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sprint">
              <select name="sprintId">
                <option value="">Backlog</option>
                {sprints
                  .filter((s: Resource) => s.data.status !== "completed")
                  .map((s: Resource) => (
                    <option value={s.id} key={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        )}
        {kind === "sprint" && (
          <div className="form-grid">
            <Field label="Inicio">
              <input type="date" name="startDate" />
            </Field>
            <Field label="Fin">
              <input type="date" name="endDate" />
            </Field>
          </div>
        )}
        {kind === "task" && (
          <ConfiguredTaskFields
            definitions={definitions}
            values={{ ...fieldDefaults(definitions), ...taskFields }}
            change={setTaskFields}
            editable
            members={members}
            required
          />
        )}
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy
              ? "Guardando…"
              : "Crear " + kindLabels[kind as ResourceKind].toLowerCase()}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ResourceDialog({
  resource,
  resources,
  members,
  canEdit,
  workspaceId,
  user,
  workspaceRole,
  close,
  save,
  create,
  open,
  error,
  notify,
  navigationGuard,
  showStructure,
  requestReminder,
}: any) {
  const [draft, setDraft] = useState<Resource>(resource),
    [dirty, setDirty] = useState(false),
    [tab, setTab] = useState(isDelivery(resource) ? "comments" : "details"),
    [versions, setVersions] = useState<any[]>([]),
    [comment, setComment] = useState(""),
    [busy, setBusy] = useState(false);
  useLocalGuard(
    dirty || busy || comment.trim()
      ? "Hay cambios o un comentario sin guardar. Guárdalos antes de cerrar sesión."
      : "",
  );
  const liveContent = useRef<DocumentNode>(
    resource.data.content || { type: "doc", content: [{ type: "paragraph" }] },
  );
  const [exportFormat, setExportFormat] = useState("markdown"),
    [documentRevisions, setDocumentRevisions] = useState<any[]>([]),
    [restoration, setRestoration] = useState<{
      revision: string;
      content: DocumentNode;
    }>(),
    [comparison, setComparison] = useState<any>(null);
  const exportDocument = async () => {
    const content = structuredClone(liveContent.current);
    const preview = exportFormat === "pdf" ? window.open("", "_blank") : null;
    try {
      if (exportFormat === "html" || exportFormat === "pdf") {
        const embed = async (node: DocumentNode): Promise<void> => {
          if (
            node.type === "image" &&
            String(node.attrs?.src || "").startsWith("/api/")
          ) {
            const response = await fetch(node.attrs!.src, {
              credentials: "same-origin",
            });
            if (!response.ok)
              throw new Error(
                "No se pudo incorporar una imagen a la exportación.",
              );
            const blob = await response.blob();
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            node.attrs = { ...node.attrs, src: data };
          }
          for (const child of node.content || []) await embed(child);
        };
        await embed(content);
      }
      if (exportFormat === "json")
        download(
          `${draft.title}.json`,
          JSON.stringify(
            { ...draft, data: { ...draft.data, content } },
            null,
            2,
          ),
          "application/json",
        );
      else if (exportFormat === "markdown")
        download(
          `${draft.title}.md`,
          "# " + draft.title + "\n\n" + documentMarkdown(content),
          "text/markdown",
        );
      else if (exportFormat === "html")
        download(
          `${draft.title}.html`,
          standaloneDocument(draft.title, content),
          "text/html",
        );
      else if (preview) {
        preview.opener = null;
        preview.document.write(standaloneDocument(draft.title, content));
        preview.document.close();
        await Promise.all(
          [...preview.document.images].map((image) =>
            image.decode().catch(() => {}),
          ),
        );
        preview.print();
      }
    } catch (e) {
      preview?.close();
      error((e as Error).message);
    }
  };
  const setData = (patch: any) => {
    setDraft((d) => ({ ...d, data: { ...d.data, ...patch } }));
    setDirty(true);
  };
  useEffect(() => {
    if (!dirty) setDraft(resource);
  }, [resource.version, dirty]);
  const persist = async () => {
    setBusy(true);
    try {
      await save(draft);
      setDirty(false);
      notify("Cambios guardados en este dispositivo.");
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const guard = () =>
      !dirty ||
      confirm("Hay cambios sin guardar. ¿Salir sin guardar estos cambios?");
    if (navigationGuard) navigationGuard.current = guard;
    return () => {
      if (navigationGuard?.current === guard)
        navigationGuard.current = () => true;
    };
  }, [dirty, navigationGuard]);
  const requestClose = () => {
    if (
      dirty &&
      !confirm("Hay cambios sin guardar. ¿Cerrar sin guardar estos cambios?")
    )
      return;
    close();
  };
  const projects = resources.filter((r: Resource) => r.kind === "project"),
    sprints = resources.filter(
      (r: Resource) => r.kind === "sprint" && r.data.status !== "completed",
    ),
    comments = resources.filter(
      (r: Resource) => r.kind === "comment" && r.data.targetId === resource.id,
    ),
    linked = resources.filter(
      (r: Resource) =>
        r.data.projectId === resource.id || r.data.parentId === resource.id,
    );
  const frozen =
    resource.kind === "sprint" && resource.data.status === "completed";
  const editable =
    canEdit &&
    !isDelivery(resource) &&
    !frozen &&
    (resource.kind !== "automation" ||
      canManageRule(resource, user.id, workspaceRole));
  return (
    <Modal
      title={
        resource.data.personalNote
          ? "Nota personal"
          : kindLabels[resource.kind as ResourceKind]
      }
      close={requestClose}
      className="resource-dialog"
      panel
    >
      {resource.data.personalNote && (
        <p className="personal-note-status" role="status">
          Nota personal · Solo tu cuenta puede consultarla en la aplicación.
        </p>
      )}
      <div className="resource-top">
        <input
          className="resource-title"
          aria-label="Título"
          value={draft.title}
          readOnly={!editable}
          onChange={(e) => {
            setDraft({ ...draft, title: e.target.value });
            setDirty(true);
          }}
        />
        <span className="resource-id">
          {resource.id.slice(0, 8)} · v{resource.version}
        </span>
      </div>
      <div className="view-tabs detail-tabs">
        <button
          className={tab === "details" ? "active" : ""}
          onClick={() => setTab("details")}
        >
          Detalles
        </button>
        <button
          className={tab === "comments" ? "active" : ""}
          onClick={() => setTab("comments")}
        >
          Comentarios · {comments.length}
        </button>
        <button
          className={tab === "history" ? "active" : ""}
          onClick={async () => {
            setTab("history");
            try {
              setVersions(
                (
                  await api(
                    `/workspaces/${workspaceId}/resources/${resource.id}/versions`,
                  )
                ).versions,
              );
            } catch (e) {
              error((e as Error).message);
            }
          }}
        >
          Historial
        </button>
      </div>
      <div className="modal-body">
        {tab === "details" && (
          <>
            {draft.kind === "automation" && (
              <AutomationFields
                draft={draft}
                members={members}
                editable={editable}
                setData={setData}
              />
            )}
            {resource.kind === "document" ? (
              <Suspense fallback={<p>Abriendo editor…</p>}>
                <CollaborativeEditor
                  documentId={resource.id}
                  hasServerContent={
                    !!resource.data.content?.content?.some(
                      (node: any) =>
                        node.type !== "paragraph" || node.content?.length,
                    )
                  }
                  workspaceId={workspaceId}
                  user={user}
                  editable={editable}
                  onContent={(content) => {
                    liveContent.current = content;
                  }}
                  restore={restoration}
                />
              </Suspense>
            ) : (
              <Field
                label={resource.kind === "sprint" ? "Objetivo" : "Descripción"}
              >
                <textarea
                  value={
                    resource.kind === "sprint"
                      ? draft.data.goal || ""
                      : draft.data.description || ""
                  }
                  readOnly={!editable}
                  rows={4}
                  onChange={(e) =>
                    setData(
                      resource.kind === "sprint"
                        ? { goal: e.target.value }
                        : { description: e.target.value },
                    )
                  }
                />
              </Field>
            )}
            {resource.data.personalNote && (
              <Field label="Resumen de la nota">
                <textarea
                  rows={3}
                  maxLength={100000}
                  readOnly={!editable}
                  value={draft.data.description || ""}
                  onChange={(event) =>
                    setData({ description: event.target.value })
                  }
                />
              </Field>
            )}
            <div className="form-grid">
              {["task", "project", "sprint"].includes(resource.kind) && (
                <Field label="Estado">
                  {resource.kind === "task" ? (
                    <WorkflowStateSelect
                      disabled={!editable}
                      task={draft}
                      projects={resources}
                      onChange={(data) =>
                        setData({ status: data.status, stateId: data.stateId ?? null })
                      }
                    />
                  ) : (
                  <select
                    disabled={!editable}
                    value={draft.data.status || ""}
                    onChange={(e) => setData({ status: e.target.value })}
                  >
                    {(resource.kind === "task"
                      ? taskStatuses
                      : resource.kind === "sprint"
                        ? ["planned", "active", "completed"]
                        : ["active", "paused", "completed"]
                    ).map((s) => (
                      <option
                        value={s}
                        key={s}
                        disabled={
                          resource.kind === "sprint" && s === "completed"
                        }
                      >
                        {statusLabels[s]}
                      </option>
                    ))}
                  </select>
                  )}
                </Field>
              )}
              {resource.kind !== "project" && !resource.data.personalNote && (
                <Field label="Proyecto">
                  <select
                    disabled={!editable || isStructure(resource)}
                    value={draft.data.projectId || ""}
                    onChange={(e) =>
                      setData({ projectId: e.target.value || null })
                    }
                  >
                    <option value="">Sin proyecto</option>
                    {projects.map((p: Resource) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {isStructure(resource) && showStructure && (
                <div className="field">
                  <span>Ubicación en la estructura</span>
                  <button type="button" onClick={() => showStructure(resource)}>
                    Organizar ubicación
                  </button>
                  <small>
                    Los movimientos se revisan antes de cambiar la ubicación o
                    el proyecto.
                  </small>
                </div>
              )}
              {resource.kind === "task" && (
                <>
                  <Field label="Responsable">
                    <select
                      disabled={!editable}
                      value={draft.data.assigneeId || ""}
                      onChange={(e) =>
                        setData({ assigneeId: e.target.value || null })
                      }
                    >
                      <option value="">Sin asignar</option>
                      {members.map((m: any) => (
                        <option value={m.id} key={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Prioridad">
                    <select
                      disabled={!editable}
                      value={draft.data.priority || "medium"}
                      onChange={(e) => setData({ priority: e.target.value })}
                    >
                      {[
                        ["none", "Sin prioridad"],
                        ["low", "Baja"],
                        ["medium", "Media"],
                        ["high", "Alta"],
                        ["urgent", "Urgente"],
                      ].map(([v, l]) => (
                        <option value={v} key={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Sprint">
                    <select
                      disabled={!editable}
                      value={draft.data.sprintId || ""}
                      onChange={(e) =>
                        setData({ sprintId: e.target.value || null })
                      }
                    >
                      <option value="">Backlog</option>
                      {sprints.map((s: Resource) => (
                        <option value={s.id} key={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Estimación en puntos">
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value={draft.data.estimate || 0}
                      readOnly={!editable}
                      onChange={(e) =>
                        setData({ estimate: Number(e.target.value) })
                      }
                    />
                  </Field>
                </>
              )}
              <Field
                label={
                  resource.kind === "sprint"
                    ? "Fecha de inicio"
                    : "Fecha límite"
                }
              >
                <input
                  type="date"
                  value={
                    resource.kind === "sprint"
                      ? draft.data.startDate || ""
                      : draft.data.dueDate || ""
                  }
                  readOnly={!editable}
                  onChange={(e) =>
                    setData(
                      resource.kind === "sprint"
                        ? { startDate: e.target.value }
                        : { dueDate: e.target.value },
                    )
                  }
                />
              </Field>
              {resource.kind === "sprint" && (
                <Field label="Fecha de fin">
                  <input
                    type="date"
                    value={draft.data.endDate || ""}
                    readOnly={!editable}
                    onChange={(e) => setData({ endDate: e.target.value })}
                  />
                </Field>
              )}
            </div>
            {resource.kind === "task" && (
              <>
                <Field label="Etiquetas, separadas por comas">
                  <input
                    readOnly={!editable}
                    value={(draft.data.labels || []).join(", ")}
                    onChange={(e) =>
                      setData({
                        labels: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
                <Field label="Criterios de aceptación">
                  <textarea
                    rows={3}
                    readOnly={!editable}
                    value={draft.data.acceptance || ""}
                    onChange={(e) => setData({ acceptance: e.target.value })}
                  />
                </Field>
                <h3>Lista de comprobación</h3>
                {(draft.data.checklist || []).map((item: any) => (
                  <label className="checklist-item" key={item.id}>
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={!editable}
                      onChange={(e) =>
                        setData({
                          checklist: draft.data.checklist.map((c: any) =>
                            c.id === item.id
                              ? { ...c, done: e.target.checked }
                              : c,
                          ),
                        })
                      }
                    />
                    <span>{item.text}</span>
                  </label>
                ))}
                {editable && (
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const text = String(
                        new FormData(form).get("item") || "",
                      ).trim();
                      if (text)
                        setData({
                          checklist: [
                            ...(draft.data.checklist || []),
                            { id: crypto.randomUUID(), text, done: false },
                          ],
                        });
                      form.reset();
                    }}
                  >
                    <input
                      name="item"
                      aria-label="Nuevo punto de comprobación"
                      placeholder="Añadir un punto…"
                      maxLength={500}
                    />
                    <button aria-label="Añadir punto">
                      <Plus size={16} />
                    </button>
                  </form>
                )}
              </>
            )}
            {resource.kind === "project" && (
              <>
                <Field label="Repositorio">
                  <input
                    type="url"
                    value={draft.data.repository || ""}
                    readOnly={!editable}
                    onChange={(e) => setData({ repository: e.target.value })}
                  />
                </Field>
                <label className="checklist-item">
                  <input
                    type="checkbox"
                    checked={draft.data.private || false}
                    disabled={!editable}
                    onChange={(e) => setData({ private: e.target.checked })}
                  />
                  Proyecto privado
                </label>
                {draft.data.private && (
                  <Field label="Miembros con acceso">
                    <select
                      multiple
                      value={draft.data.members || []}
                      disabled={!editable}
                      onChange={(e) =>
                        setData({
                          members: [...e.target.selectedOptions].map(
                            (o) => o.value,
                          ),
                        })
                      }
                    >
                      {members.map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            )}
            {resource.kind === "sprint" && (
              <>
                <Field label="Definición de terminado">
                  <textarea
                    value={draft.data.definitionOfDone || ""}
                    readOnly={!editable}
                    rows={3}
                    onChange={(e) =>
                      setData({ definitionOfDone: e.target.value })
                    }
                  />
                </Field>
                <h3>Tareas del sprint</h3>
                {resources
                  .filter(
                    (r: Resource) =>
                      r.kind === "task" && r.data.sprintId === resource.id,
                  )
                  .map((r: Resource) => (
                    <button
                      className="linked-row"
                      key={r.id}
                      onClick={() => open(r)}
                    >
                      <StatusIcon status={r.data.status} />
                      {r.title}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                {frozen && (
                  <p className="notice">
                    Este sprint conserva una fotografía de{" "}
                    {(resource.data.snapshot || []).length} tareas al cerrarse.
                  </p>
                )}
              </>
            )}
            {linked.length > 0 && (
              <section>
                <h3>Elementos relacionados</h3>
                {linked.map((r: Resource) => (
                  <button
                    className="linked-row"
                    key={r.id}
                    onClick={() => open(r)}
                  >
                    <span>{kindLabels[r.kind]}</span>
                    {r.title}
                    <ArrowRight size={14} />
                  </button>
                ))}
              </section>
            )}
          </>
        )}
        {tab === "comments" && (
          <>
            <div className="comments">
              {comments.map((c: Resource) => (
                <article key={c.id}>
                  <div>
                    <span className="avatar small">
                      {members
                        .find((m: any) => m.id === c.created_by)
                        ?.name?.slice(0, 2)
                        .toUpperCase()}
                    </span>
                    <strong>
                      {members.find((m: any) => m.id === c.created_by)?.name ||
                        "Miembro"}
                    </strong>
                    <time>{dateText(c.created_at)}</time>
                  </div>
                  <p>{c.data.description}</p>
                </article>
              ))}
              {!comments.length && (
                <p className="muted">
                  Aún no hay comentarios. Comparte una pregunta o una decisión.
                </p>
              )}
            </div>
            {canEdit && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!comment.trim()) return;
                  await create("comment", `Comentario en ${resource.title}`, {
                    description: comment,
                    targetId: resource.id,
                    ...(resource.data.projectId
                      ? { projectId: resource.data.projectId }
                      : resource.kind === "project"
                        ? { projectId: resource.id }
                        : {}),
                  });
                  setComment("");
                }}
              >
                <Field label="Añadir comentario">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    required
                    rows={3}
                  />
                </Field>
                <div className="mention-controls">
                  <span>Mencionar:</span>
                  {members.slice(0, 12).map((member: any) => (
                    <button
                      type="button"
                      className="text-button"
                      key={member.id}
                      onClick={() =>
                        setComment((value) => value + ` @${member.email} `)
                      }
                    >
                      {member.name}
                    </button>
                  ))}
                </div>
                <button className="primary">Comentar</button>
              </form>
            )}
          </>
        )}
        {tab === "history" && (
          <div className="history-list">
            {resource.kind === "document" && (
              <section>
                <div className="section-heading">
                  <h3>Versiones del contenido</h3>
                  <button
                    onClick={async () => {
                      try {
                        setDocumentRevisions(
                          (
                            await api(
                              `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                            )
                          ).revisions,
                        );
                      } catch (e) {
                        error((e as Error).message);
                      }
                    }}
                  >
                    Consultar versiones
                  </button>
                </div>
                {editable && (
                  <button
                    onClick={async () => {
                      try {
                        await api(
                          `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                          send({}),
                        );
                        setDocumentRevisions(
                          (
                            await api(
                              `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                            )
                          ).revisions,
                        );
                        notify("Versión del servidor conservada.");
                      } catch (e) {
                        error((e as Error).message);
                      }
                    }}
                  >
                    Conservar versión actual del servidor
                  </button>
                )}
                {documentRevisions.map((revision) => (
                  <article key={revision.id}>
                    <div>
                      <strong>Contenido · {revision.author || "Equipo"}</strong>
                      <time>
                        {new Date(revision.created_at).toLocaleString("es")}
                      </time>
                    </div>
                    <p>
                      {documentText(revision.content).slice(0, 220) ||
                        "Documento vacío"}
                    </p>
                    <button onClick={() => setComparison(revision)}>
                      Comparar con el contenido actual
                    </button>
                    {editable && (
                      <button
                        onClick={async () => {
                          if (
                            !confirm(
                              "¿Restaurar esta versión del contenido? Se guardará antes una copia de la versión actual del servidor.",
                            )
                          )
                            return;
                          try {
                            await api(
                              `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                              send({}),
                            );
                            setRestoration({
                              revision: String(revision.id) + "-" + Date.now(),
                              content: revision.content,
                            });
                            setTab("details");
                          } catch (e) {
                            error((e as Error).message);
                          }
                        }}
                      >
                        Restaurar contenido
                      </button>
                    )}
                  </article>
                ))}
                {comparison && (
                  <div className="revision-comparison">
                    <h3>Comparación de contenido</h3>
                    <div>
                      <section>
                        <h4>Versión seleccionada</h4>
                        <pre>{documentText(comparison.content)}</pre>
                      </section>
                      <section>
                        <h4>Contenido actual en este dispositivo</h4>
                        <pre>{documentText(liveContent.current)}</pre>
                      </section>
                    </div>
                    <button onClick={() => setComparison(null)}>
                      Cerrar comparación
                    </button>
                  </div>
                )}
              </section>
            )}
            {versions.map((v) => (
              <article key={v.version}>
                <div>
                  <strong>Versión {v.version}</strong>
                  <span>{new Date(v.created_at).toLocaleString("es")}</span>
                </div>
                <p>{v.snapshot.title}</p>
                {editable && v.version !== resource.version && (
                  <button
                    onClick={() => {
                      setDraft({
                        ...resource,
                        title: v.snapshot.title,
                        data: v.snapshot.data,
                      });
                      setDirty(true);
                      setTab("details");
                    }}
                  >
                    Revisar esta versión
                  </button>
                )}
              </article>
            ))}
            {!versions.length && <p>No hay versiones sincronizadas.</p>}
          </div>
        )}
        {tab === "details" && (
          <>
            <ResourceRelations
              draft={draft}
              resources={resources}
              members={members}
              editable={editable}
              setData={setData}
              open={open}
              create={create}
            />
            <Attachments
              workspaceId={workspaceId}
              resourceId={resource.id}
              userId={user.id}
              editable={editable}
              error={error}
            />
          </>
        )}
      </div>
      <footer className="modal-footer">
        <div>
          <ResourceLink id={resource.id} />
          {["project", "document"].includes(resource.kind) && (
            <button
              className="text-button"
              onClick={async () => {
                setBusy(true);
                try {
                  const { downloadDocuments } =
                    await import("./offline-documents");
                  const documents =
                    resource.kind === "document"
                      ? [resource]
                      : resources.filter(
                          (r: Resource) =>
                            r.kind === "document" &&
                            r.data.projectId === resource.id,
                        );
                  const count = await downloadDocuments(
                    user.id,
                    workspaceId,
                    documents,
                  );
                  notify(
                    `${count} documentos descargados para trabajar sin conexión.`,
                  );
                } catch (e) {
                  error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Descargar para sin conexión
            </button>
          )}
          {editable && (
            <button
              className="danger text-button"
              onClick={async () => {
                if (!confirm(`¿Mover «${resource.title}» a la papelera?`))
                  return;
                await save({
                  ...resource,
                  deleted_at: new Date().toISOString(),
                });
                close();
              }}
            >
              <Trash2 size={15} />
              Eliminar
            </button>
          )}
          {canEdit && reminderTargetKinds.has(resource.kind) && (
            <button
              className="text-button"
              onClick={() => requestReminder(resource)}
            >
              <Bell size={15} />
              Crear recordatorio personal
            </button>
          )}
          {resource.kind === "document" && (
            <select
              aria-label="Formato de exportación"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value)}
            >
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
              <option value="pdf">Imprimir / PDF</option>
              <option value="json">JSON</option>
            </select>
          )}
          <button
            className="text-button"
            onClick={() =>
              resource.kind === "document"
                ? exportDocument()
                : download(
                    `${draft.title}.json`,
                    JSON.stringify(draft, null, 2),
                    "application/json",
                  )
            }
          >
            <ArrowDownToLine size={15} />
            Exportar
          </button>
        </div>
        <div>
          <span className="muted">
            {dirty ? "Cambios sin guardar" : "Guardado"}
          </span>
          {editable && (
            <button
              className="primary"
              disabled={!dirty || busy || !draft.title.trim()}
              onClick={() => void persist()}
            >
              {busy ? "Guardando…" : "Guardar cambios"}
            </button>
          )}
        </div>
      </footer>
    </Modal>
  );
}
