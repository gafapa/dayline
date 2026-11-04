import { acceptsChild } from "../shared/hierarchy";
import { lazy, Suspense, useState } from "react";
import { useServerCommand } from "./useServerCommand";
import { Field, Modal } from "./components/Primitives";
import { useSprintDraft } from "./useSprintDraft";
import {
  templateBlueprintSchema,
  rewriteDocument,
  type TemplateBlueprint,
} from "../shared/collections";
import {
  kindLabels,
  type Resource,
  type User,
  type Workspace,
} from "../shared/model";
const Editor = lazy(() => import("./Editor"));
type Props = {
  resources: Resource[];
  user: User;
  workspace: Workspace;
  canEdit: boolean;
  create: (
    kind: "template",
    title: string,
    data: Record<string, any>,
  ) => Promise<Resource | undefined>;
  save: (resource: Resource) => Promise<Resource | undefined>;
  refresh: () => Promise<void>;
};
const today = () => new Date().toISOString().slice(0, 10);
const emptyBlueprint = (
  kind: "project" | "task" | "document",
): TemplateBlueprint => ({
  version: 1,
  rootKey: "root",
  nodes: [
    {
      key: "root",
      kind,
      title: kindLabels[kind],
      data: { description: "" },
      dependencies: [],
      related: [],
    },
  ],
});

export default function TemplateLibrary(props: Props) {
  const { resources, user, workspace, canEdit, create, save, refresh } = props;
  const [editing, setEditing] = useState<Resource | null | undefined>(),
    [capture, setCapture] = useState(false),
    [applying, setApplying] = useState<Resource | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const templates = resources.filter(
      (r) =>
        r.kind === "template" &&
        !r.deleted_at &&
        !r.data.archived &&
        r.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ),
    sources = resources.filter(
      (r) =>
        ["project", "task", "document"].includes(r.kind) &&
        !r.deleted_at &&
        !r.data.archived,
    );
  const command = useServerCommand(
    user.id,
    workspace.id,
    "templates",
    async (result) => {
      await refresh();
      setCapture(false);
      setApplying(null);
      setNotice(
        `Comando confirmado: ${result.count ?? result.nodeCount} elementos y ${result.attachmentCount} adjuntos.`,
      );
    },
  );
  return (
    <section className="template-library" aria-label="Biblioteca de plantillas">
      {command.recovery}
      <div className="collection-tools">
        <p className="muted">
          Reutiliza la estructura y los documentos de tu equipo.
        </p>
        {canEdit && (
          <>
            <button className="secondary" onClick={() => setCapture(true)}>
              Capturar proyecto o documento
            </button>
            <button className="primary" onClick={() => setEditing(null)}>
              Nueva plantilla
            </button>
          </>
        )}
      </div>
      <Field label="Buscar plantillas">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="template-list">
        {templates.map((template) => {
          const parsed = templateBlueprintSchema.safeParse(
              template.data.templateBlueprint,
            ),
            blueprint = parsed.success ? parsed.data : null,
            root = blueprint?.nodes.find((n) => n.key === blueprint.rootKey);
          return (
            <article className="template-row" key={template.id}>
              <div>
                <h2>{template.title}</h2>
                <p className="muted">
                  {root ? kindLabels[root.kind] : "Sin configurar"}
                  {blueprint
                    ? ` · ${blueprint.nodes.length} elementos`
                    : ""} ·{" "}
                  {template.data.ownerId
                    ? "Personal"
                    : "Compartida según permisos"}
                </p>
                <p>{template.data.description}</p>
              </div>
              <div className="template-actions">
                {canEdit && blueprint && (
                  <button
                    className="secondary"
                    onClick={() => setApplying(template)}
                  >
                    Usar plantilla
                  </button>
                )}
                {canEdit &&
                  (template.created_by === user.id ||
                    workspace.role === "admin") && (
                    <button
                      className="text-button"
                      onClick={() => setEditing(template)}
                    >
                      Editar plantilla
                    </button>
                  )}
              </div>
            </article>
          );
        })}
      </div>
      {!templates.length && (
        <div className="inline-empty">
          <p>
            No hay plantillas en esta colección. Crea una estructura o captura
            un proyecto, una tarea o un documento existente.
          </p>
        </div>
      )}
      <p className="muted">
        Cada uso crea elementos independientes. Las tareas empiezan en el
        backlog, sin responsables ni sprint; las listas se reinician. Las fechas
        se desplazan desde la fecha de referencia. Los documentos personales
        conservan su privacidad.
      </p>
      {capture && (
        <Modal
          title="Capturar como plantilla"
          close={() => {
            if (!busy) setCapture(false);
          }}
        >
          <form
            className="modal-body"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                source = sources.find((r) => r.id === form.get("source"));
              if (!source) return;
              setBusy(true);
              setError("");
              try {
                const result = await command.run(
                  `/workspaces/${workspace.id}/templates/capture`,
                  {
                    sourceId: source.id,
                    expectedVersion: source.version,
                    title: String(form.get("title")),
                    anchorDate: String(form.get("date")),
                    shared: !!form.get("shared"),
                  },
                );
                await refresh();
                setCapture(false);
                setNotice(
                  `Plantilla confirmada por el servidor: ${result.nodeCount} elementos y ${result.attachmentCount} adjuntos copiados.`,
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Origen de la plantilla">
              <select name="source" required disabled={busy}>
                {sources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {kindLabels[r.kind]} · {r.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nombre de la plantilla">
              <input name="title" required maxLength={500} disabled={busy} />
            </Field>
            <Field label="Fecha de referencia">
              <input
                name="date"
                type="date"
                required
                defaultValue={today()}
                disabled={busy}
              />
            </Field>
            <label className="check-field">
              <input name="shared" type="checkbox" disabled={busy} />
              Compartir dentro de los permisos originales
            </label>
            <p className="muted">
              Se incluye la jerarquía completa y el último contenido
              colaborativo guardado en el servidor. Espera a que el documento
              confirme su sincronización. La plantilla mantiene los permisos
              originales y actuales de sus fuentes; compartirla no publica notas
              privadas. Máximo 200 elementos, 900 KiB de datos y 100 MiB de
              adjuntos activos por espacio.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button
              className="primary"
              disabled={busy || !navigator.onLine || !sources.length}
            >
              {busy ? "Copiando…" : "Capturar plantilla"}
            </button>
          </form>
        </Modal>
      )}
      {editing !== undefined && (
        <TemplateBuilder
          key={editing?.id || "new"}
          resource={editing}
          user={user}
          workspace={workspace}
          create={create}
          save={save}
          close={() => setEditing(undefined)}
          done={() => {
            setEditing(undefined);
            setNotice(
              "Plantilla guardada en este dispositivo; pendiente de sincronización.",
            );
          }}
        />
      )}
      {applying && (
        <ApplyTemplate
          resource={applying}
          run={command.run}
          resources={resources}
          workspace={workspace}
          close={() => setApplying(null)}
          done={async (result) => {
            await refresh();
            setApplying(null);
            setNotice(
              `${result.count} elementos y ${result.attachmentCount} adjuntos creados. Confirmado por el servidor.`,
            );
          }}
        />
      )}
    </section>
  );
}

function TemplateBuilder({
  resource,
  user,
  workspace,
  create,
  save,
  close,
  done,
}: {
  resource: Resource | null;
  user: User;
  workspace: Workspace;
  create: Props["create"];
  save: Props["save"];
  close: () => void;
  done: () => void;
}) {
  const initial = templateBlueprintSchema.safeParse(
    resource?.data.templateBlueprint,
  );
  const [blueprint, setBlueprint] = useState<TemplateBlueprint>(
      initial.success ? initial.data : emptyBlueprint("project"),
    ),
    [title, setTitle] = useState(resource?.title || ""),
    [description, setDescription] = useState(resource?.data.description || ""),
    [shared, setShared] = useState(!!resource && !resource.data.ownerId),
    [nodeKey, setNodeKey] = useState(
      initial.success ? initial.data.rootKey : "root",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [baseVersion, setBaseVersion] = useState(resource?.version || 0);
  const draft = useSprintDraft(
    user.id,
    `${workspace.id}:template:${resource?.id || "new"}`,
    { blueprint, title, description, shared, baseVersion },
    dirty,
    (value) => {
      const parsed = templateBlueprintSchema.safeParse(value.blueprint);
      if (
        !parsed.success ||
        typeof value.title !== "string" ||
        typeof value.description !== "string" ||
        typeof value.shared !== "boolean" ||
        !Number.isInteger(value.baseVersion)
      )
        throw new Error("Invalid template draft");
      setBlueprint(parsed.data);
      setNodeKey(parsed.data.rootKey);
      setTitle(value.title);
      setDescription(value.description);
      setShared(value.shared);
      setBaseVersion(value.baseVersion);
      setDirty(true);
    },
  );
  const node =
      blueprint.nodes.find((n) => n.key === nodeKey) || blueprint.nodes[0],
    root = blueprint.nodes.find((n) => n.key === blueprint.rootKey)!;
  const change = (patch: Partial<typeof node>) => {
    setDirty(true);
    setBlueprint((b) => ({
      ...b,
      nodes: b.nodes.map((n) => (n.key === node.key ? { ...n, ...patch } : n)),
    }));
  };
  const changeData = (patch: Record<string, unknown>) =>
    change({ data: { ...node.data, ...patch } });
  const descendants = new Set([node.key]);
  for (let count = -1; count !== descendants.size;) {
    count = descendants.size;
    for (const candidate of blueprint.nodes)
      if (
        descendants.has(candidate.parentKey || "") ||
        descendants.has(candidate.projectKey || "")
      )
        descendants.add(candidate.key);
  }
  const createsDependencyCycle = (key: string) => {
    const pending = [key],
      seen = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === node.key) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(
        ...(blueprint.nodes.find((n) => n.key === next)?.dependencies || []),
      );
    }
    return false;
  };
  function add(kind: "project" | "folder" | "task" | "document") {
    const key = crypto.randomUUID();
    setDirty(true);
    setBlueprint((b) => ({
      ...b,
      nodes: [
        ...b.nodes,
        {
          key,
          kind,
          title: kindLabels[kind],
          data: { description: "" },
          dependencies: [],
          related: [],
          ...(kind === "project"
            ? { parentKey: root.key }
            : root.kind === "project"
              ? { projectKey: root.key }
              : { parentKey: root.key }),
        },
      ],
    }));
    setNodeKey(key);
  }
  function remove() {
    const keys = new Set([node.key]);
    let count = -1;
    while (count !== keys.size) {
      count = keys.size;
      for (const n of blueprint.nodes)
        if (keys.has(n.parentKey || "") || keys.has(n.projectKey || ""))
          keys.add(n.key);
    }
    setDirty(true);
    setBlueprint((b) => ({
      ...b,
      nodes: b.nodes
        .filter((n) => !keys.has(n.key))
        .map((n) => ({
          ...n,
          dependencies: n.dependencies.filter((k) => !keys.has(k)),
          related: n.related.filter((k) => !keys.has(k)),
          data: {
            ...n.data,
            ...(n.data.content
              ? {
                  content: rewriteDocument(n.data.content, (entry) => {
                    if (entry.marks)
                      entry.marks = entry.marks.filter(
                        (mark: any) =>
                          !keys.has(
                            /^\/\?templateNode=(.*)$/.exec(
                              String(mark.attrs?.href),
                            )?.[1] || "",
                          ),
                      );
                    return entry;
                  }),
                }
              : {}),
          },
        })),
    }));
    setNodeKey(root.key);
  }
  const leave = () => {
    if (
      !dirty ||
      confirm(
        "El borrador se conservará en este dispositivo. ¿Cerrar el editor?",
      )
    )
      close();
  };
  return (
    <Modal
      title={resource ? "Editar plantilla" : "Nueva plantilla"}
      close={() => {
        if (!busy) leave();
      }}
      className="template-modal"
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            templateBlueprintSchema.parse(blueprint);
            const data = {
              ...resource?.data,
              description,
              templateBlueprint: blueprint,
              ownerId: shared ? undefined : user.id,
            };
            if (resource)
              await save({ ...resource, version: baseVersion, title, data });
            else await create("template", title, data);
            await draft.clear();
            done();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {draft.issue && (
          <p className="error" role="alert">
            {draft.issue}{" "}
            <button
              type="button"
              onClick={async () => {
                await draft.clear();
                close();
              }}
            >
              Descartar borrador local
            </button>
          </p>
        )}
        <fieldset disabled={!draft.ready || busy} className="template-fieldset">
          <div className="collection-filters">
            <Field label="Nombre de la plantilla">
              <input
                required
                maxLength={500}
                value={title}
                onChange={(e) => {
                  setDirty(true);
                  setTitle(e.target.value);
                }}
              />
            </Field>
            <Field label="Descripción de la plantilla">
              <input
                value={description}
                maxLength={10000}
                onChange={(e) => {
                  setDirty(true);
                  setDescription(e.target.value);
                }}
              />
            </Field>
            <label className="check-field">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => {
                  setDirty(true);
                  setShared(e.target.checked);
                }}
              />
              Compartida según permisos
            </label>
          </div>
          {!resource && blueprint.nodes.length === 1 && (
            <Field label="Tipo de plantilla">
              <select
                value={root.kind}
                onChange={(e) => {
                  setDirty(true);
                  setBlueprint(emptyBlueprint(e.target.value as any));
                  setNodeKey("root");
                }}
              >
                <option value="project">Proyecto</option>
                <option value="task">Tarea</option>
                <option value="document">Documento</option>
              </select>
            </Field>
          )}
          <div className="template-builder">
            <div className="template-outline">
              <Field label="Elemento de plantilla">
                <select
                  size={Math.min(8, blueprint.nodes.length + 1)}
                  value={node.key}
                  onChange={(e) => setNodeKey(e.target.value)}
                >
                  {blueprint.nodes.map((n) => (
                    <option key={n.key} value={n.key}>
                      {n.key === root.key ? "Raíz · " : ""}
                      {kindLabels[n.kind]} · {n.title}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="template-actions">
                {(root.kind === "project"
                  ? ["project", "folder", "task", "document"]
                  : [root.kind]
                ).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="secondary"
                    disabled={blueprint.nodes.length >= 200}
                    onClick={() => add(kind as any)}
                  >
                    Añadir{" "}
                    {kindLabels[kind as keyof typeof kindLabels]?.toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            <section className="template-node">
              <h3>{kindLabels[node.kind]}</h3>
              <Field label="Título del elemento">
                <input
                  required
                  maxLength={500}
                  value={node.title}
                  onChange={(e) => change({ title: e.target.value })}
                />
              </Field>
              <Field label="Descripción del elemento">
                <textarea
                  value={String(node.data.description || "")}
                  maxLength={100000}
                  onChange={(e) => changeData({ description: e.target.value })}
                />
              </Field>
              {node.key !== root.key && (
                <div className="collection-filters">
                  {node.kind !== "project" && root.kind === "project" && (
                    <Field label="Proyecto del elemento">
                      <select
                        value={node.projectKey || root.key}
                        onChange={(e) =>
                          change({
                            projectKey: e.target.value,
                            parentKey: undefined,
                          })
                        }
                      >
                        {blueprint.nodes
                          .filter((n) => n.kind === "project")
                          .map((n) => (
                            <option key={n.key} value={n.key}>
                              {n.title}
                            </option>
                          ))}
                      </select>
                    </Field>
                  )}
                  <Field label="Elemento superior">
                    <select
                      value={node.parentKey || ""}
                      onChange={(e) =>
                        change({ parentKey: e.target.value || undefined })
                      }
                    >
                      <option
                        value=""
                        disabled={
                          node.kind === "project" || root.kind !== "project"
                        }
                      >
                        Sin elemento superior
                      </option>
                      {blueprint.nodes
                        .filter(
                          (n) =>
                            ((n.kind === node.kind && node.kind === "task") ||
                              acceptsChild(n.kind, node.kind)) &&
                            !descendants.has(n.key),
                        )
                        .map((n) => (
                          <option key={n.key} value={n.key}>
                            {n.title}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              )}
              {node.kind === "task" && (
                <>
                  <div className="collection-filters">
                    <Field label="Estimación de plantilla">
                      <input
                        type="number"
                        min="0"
                        max="10000"
                        value={Number(node.data.estimate || 0)}
                        onChange={(e) =>
                          changeData({ estimate: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Etiquetas de plantilla">
                      <input
                        value={((node.data.labels || []) as string[]).join(
                          ", ",
                        )}
                        onChange={(e) =>
                          changeData({
                            labels: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </Field>
                    <Field label="Días hasta vencimiento">
                      <input
                        type="number"
                        min="-3650"
                        max="3650"
                        value={node.dueOffset ?? ""}
                        onChange={(e) =>
                          change({
                            dueOffset: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                      />
                    </Field>
                    <Field label="Dependencias de plantilla">
                      <select
                        multiple
                        value={node.dependencies}
                        onChange={(e) =>
                          change({
                            dependencies: [...e.target.selectedOptions].map(
                              (o) => o.value,
                            ),
                          })
                        }
                      >
                        {blueprint.nodes
                          .filter(
                            (n) =>
                              n.kind === "task" &&
                              !createsDependencyCycle(n.key),
                          )
                          .map((n) => (
                            <option value={n.key} key={n.key}>
                              {n.title}
                            </option>
                          ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Lista de comprobación de plantilla">
                    <textarea
                      value={((node.data.checklist || []) as any[])
                        .map((c) => c.text)
                        .join("\n")}
                      onChange={(e) =>
                        changeData({
                          checklist: e.target.value
                            .split("\n")
                            .filter(Boolean)
                            .map((text, index) => ({
                              id:
                                ((node.data.checklist || []) as any[])[index]
                                  ?.id || crypto.randomUUID(),
                              text,
                              done: false,
                            })),
                        })
                      }
                    />
                  </Field>
                </>
              )}
              {node.kind === "document" && (
                <>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={!!node.personal}
                      onChange={(e) => change({ personal: e.target.checked })}
                    />
                    Documento personal para quien use la plantilla
                  </label>
                  <Suspense fallback={<p role="status">Preparando editor…</p>}>
                    {draft.ready && (
                      <Editor
                        key={node.key}
                        content={node.data.content}
                        documentSchemaVersion={
                          node.data.documentSchemaVersion as number | undefined
                        }
                        onChange={(content) => changeData({ content })}
                      />
                    )}
                  </Suspense>
                </>
              )}
              {node.key !== root.key && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    if (
                      confirm(
                        "¿Quitar este elemento y todos sus descendientes de la plantilla?",
                      )
                    )
                      remove();
                  }}
                >
                  Quitar elemento y descendientes
                </button>
              )}
            </section>
          </div>
          {resource?.data.templateScopes?.length > 0 && (
            <p className="muted">
              Esta captura conserva los permisos originales y actuales de sus
              fuentes, incluso al compartirla.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="template-actions">
            <button className="primary" disabled={!!draft.issue}>
              {busy ? "Guardando…" : "Guardar plantilla"}
            </button>
            <span className="muted" role="status">
              {draft.saved ? "Borrador conservado en este dispositivo" : ""}
            </span>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function ApplyTemplate({
  resource,
  resources,
  workspace,
  close,
  done,
  run,
}: {
  run: (path: string, body: Record<string, any>) => Promise<any>;
  resource: Resource;
  resources: Resource[];
  workspace: Workspace;
  close: () => void;
  done: (result: any) => Promise<void>;
}) {
  const blueprint = templateBlueprintSchema.parse(
      resource.data.templateBlueprint,
    ),
    root = blueprint.nodes.find((n) => n.key === blueprint.rootKey)!,
    projects = resources.filter(
      (r) => r.kind === "project" && !r.deleted_at && !r.data.archived,
    );
  const [visibility, setVisibility] = useState(
      root.kind === "task" ? "project" : "private",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={`Usar ${resource.title}`}
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            const result = await run(
              `/workspaces/${workspace.id}/templates/${resource.id}/apply`,
              {
                expectedVersion: resource.version,
                title: String(form.get("title")),
                baseDate: String(form.get("date")),
                visibility,
                ...(visibility === "project"
                  ? { destinationProjectId: String(form.get("project")) }
                  : {}),
              },
            );
            await done(result);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {blueprint.nodes.filter((n) => n.kind === "project").length} proyectos
          · {blueprint.nodes.filter((n) => n.kind === "task").length} tareas ·{" "}
          {blueprint.nodes.filter((n) => n.kind === "document").length}{" "}
          documentos
        </p>
        <Field label="Título de la nueva raíz">
          <input
            name="title"
            required
            maxLength={500}
            defaultValue={root.title}
            disabled={busy}
          />
        </Field>
        <Field label="Fecha base de la copia">
          <input
            name="date"
            type="date"
            required
            defaultValue={today()}
            disabled={busy}
          />
        </Field>
        <Field label="Destino y visibilidad">
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            disabled={busy}
          >
            {root.kind !== "task" && (
              <option value="private">
                {root.kind === "document"
                  ? "Documento personal"
                  : "Proyecto privado"}
              </option>
            )}
            <option value="project">Dentro de un proyecto</option>
            <option value="workspace">Visible en el espacio</option>
          </select>
        </Field>
        {visibility === "project" && (
          <Field label="Proyecto de destino">
            <select name="project" required disabled={busy}>
              <option value="">Elige un proyecto</option>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="muted">
          Se copian los adjuntos y se crean identificadores nuevos. No se copian
          responsables, sprints, votos, historial ni automatizaciones. Las
          tareas y sus comprobaciones se reinician. Las fechas mantienen sus
          distancias respecto a la fecha de referencia.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !navigator.onLine}>
          {busy ? "Creando copia…" : "Crear desde plantilla"}
        </button>
      </form>
    </Modal>
  );
}
