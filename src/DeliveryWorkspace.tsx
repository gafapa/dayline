import { ResourceLink } from "./ResourceLink";
import { useEffect, useState } from "react";
import { Field, Modal } from "./components/Primitives";
import { api } from "./api";
import { flushOutbox } from "./storage";
import { useServerCommand } from "./useServerCommand";
import { useSprintDraft } from "./useSprintDraft";
import { Attachments } from "./Attachments";
import { AutomationHistory } from "./Automations";
import {
  deliveryKinds,
  deliveryStatuses,
  deliveryStatusLabels,
  deliverySchema,
  deliveryDraftIssues,
  localDeliveryReadinessIssues,
  defaultDelivery,
  isDelivery,
  belongsToProject,
  type DeliveryKind,
} from "../shared/delivery";
import {
  kindLabels,
  resourceDataSchema,
  statusLabels,
  type Resource,
  type ResourceKind,
  type User,
  type Workspace,
} from "../shared/model";
import { validDay } from "../shared/time";
type Props = {
  resources: Resource[];
  members: { id: string; name: string }[];
  user: User;
  workspace: Workspace;
  focusId: string | null;
  setFocus: (id: string | null) => void;
  open: (resource: Resource) => void;
  create: (
    kind: ResourceKind,
    title: string,
    data: Record<string, any>,
  ) => Promise<Resource | undefined>;
  save: (resource: Resource) => Promise<Resource | undefined>;
  refresh: () => Promise<void>;
  legacyCreate: (kind: ResourceKind) => void;
  discuss: (resource: Resource) => void;
};
const dateText = (day?: string) =>
  day && validDay(day)
    ? new Intl.DateTimeFormat("es", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(day + "T12:00:00Z"))
    : "Sin fecha";
const initialStatus = (kind: DeliveryKind) =>
  kind === "decision" ? "proposed" : kind === "risk" ? "identified" : "planned";

export default function DeliveryWorkspace(props: Props) {
  const { resources, workspace, user, focusId, setFocus, open } = props;
  const [area, setArea] = useState("roadmap"),
    [projectId, setProjectId] = useState(""),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(100),
    [editor, setEditor] = useState<{
      resource: Resource | null;
      kind: DeliveryKind;
    } | null>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [online, setOnline] = useState(navigator.onLine),
    [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => setEditor(null), [focusId]);
  const canEdit = workspace.role !== "viewer",
    active = resources.filter((r) => !r.deleted_at),
    projects = active.filter((r) => r.kind === "project" && !r.data.archived),
    focused = active.find((r) => r.id === focusId && isDelivery(r));
  const command = useServerCommand(
    user.id,
    workspace.id,
    "delivery",
    async (result) => {
      await props.refresh();
      setFocus(result.resourceId);
      setNotice(
        "Confirmación recuperada del servidor sin duplicar la entrega.",
      );
    },
  );
  const records = active
    .filter(
      (r) =>
        isDelivery(r) &&
        (showArchived || !r.data.archived) &&
        (!projectId || belongsToProject(r, projectId, resources)) &&
        (!query ||
          `${r.title} ${r.data.goal || ""} ${r.data.description || ""}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())),
    )
    .sort(
      (a, b) =>
        (a.data.dueDate || "9999").localeCompare(b.data.dueDate || "9999") ||
        a.title.localeCompare(b.title),
    );
  const visible = records.filter((r) =>
      area === "roadmap"
        ? ["milestone", "release"].includes(r.kind)
        : r.kind === area,
    ),
    filters = (
      <div className="collection-filters">
        <Field label="Proyecto de planificación">
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setLimit(100);
            }}
          >
            <option value="">Todos los proyectos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buscar planificación">
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(100);
            }}
          />
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Incluir archivados
        </label>
      </div>
    );
  return (
    <section
      className="delivery-workspace"
      aria-label="Planificación de entregas"
    >
      {command.recovery}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {focused ? (
        <DeliveryDetail
          key={`detail-${focused.id}`}
          resource={focused}
          resources={resources}
          members={props.members}
          canEdit={canEdit}
          online={online}
          user={user}
          workspace={workspace}
          open={open}
          back={() => setFocus(null)}
          edit={() =>
            setEditor({ resource: focused, kind: focused.kind as DeliveryKind })
          }
          refresh={props.refresh}
          discuss={() => props.discuss(focused)}
          save={props.save}
          run={command.run}
          confirmed={async () => {
            await props.refresh();
            setNotice(
              "Entrega confirmada en el servidor. Se conserva su alcance histórico.",
            );
          }}
        />
      ) : (
        <>
          <nav
            className="view-tabs delivery-tabs"
            aria-label="Áreas de planificación"
          >
            {["roadmap", ...deliveryKinds, "rules", "team"].map((key) => (
              <button
                key={key}
                aria-pressed={area === key}
                className={area === key ? "active" : ""}
                onClick={() => {
                  setArea(key);
                  setLimit(100);
                }}
              >
                {key === "roadmap"
                  ? "Hoja de ruta"
                  : key === "rules"
                    ? "Reglas y ejecuciones"
                    : key === "team"
                      ? "Equipos"
                      : kindLabels[key as DeliveryKind]}
              </button>
            ))}
          </nav>
          {["roadmap", ...deliveryKinds].includes(area) && (
            <>
              {filters}
              <div className="collection-summary">
                <p>
                  {visible.length}{" "}
                  {area === "roadmap" ? "hitos y versiones" : "registros"}
                </p>
                {canEdit && (
                  <div className="template-actions">
                    {(area === "roadmap"
                      ? ["milestone", "release"]
                      : [area]
                    ).map((kind) => (
                      <button
                        className="secondary"
                        key={kind}
                        onClick={() =>
                          setEditor({
                            resource: null,
                            kind: kind as DeliveryKind,
                          })
                        }
                      >
                        Crear {kindLabels[kind as DeliveryKind].toLowerCase()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {area === "roadmap" && (
                <Roadmap records={visible.slice(0, limit)} open={open} />
              )}
              <div className="delivery-list">
                {visible.slice(0, limit).map((resource) => {
                  const value = resource.data.delivery,
                    scope = (value?.taskIds || [])
                      .map((id: string) => resources.find((r) => r.id === id))
                      .filter(Boolean),
                    done = scope.filter((r: Resource) =>
                      ["done", "cancelled"].includes(r.data.status),
                    ).length;
                  return (
                    <article className="delivery-row" key={resource.id}>
                      <div>
                        <button
                          className="task-name"
                          onClick={() => open(resource)}
                        >
                          <strong>{resource.title}</strong>
                        </button>
                        <p className="muted">
                          {projects.find(
                            (p) => p.id === resource.data.projectId,
                          )?.title || "Proyecto archivado"}{" "}
                          ·{" "}
                          {deliveryStatusLabels[resource.data.status] ||
                            "Sin configurar"}
                          {resource.data.archived ? " · Archivado" : ""}
                        </p>
                        <p>{resource.data.goal || resource.data.description}</p>
                      </div>
                      <div className="delivery-row-metadata">
                        <span>{dateText(resource.data.dueDate)}</span>
                        {resource.kind === "risk" && value ? (
                          <span
                            className={
                              value.probability * value.impact >= 15
                                ? "negative"
                                : ""
                            }
                          >
                            Riesgo {value.probability * value.impact}/25
                          </span>
                        ) : scope.length > 0 ? (
                          <span>
                            {done}/{scope.length} tareas resueltas
                          </span>
                        ) : resource.kind === "release" ? (
                          <span>{value?.version || "Sin versión"}</span>
                        ) : null}
                        {resource.data.deliveryReceipt && (
                          <span>
                            Confirmado{" "}
                            {dateText(
                              resource.data.deliveryReceipt.at.slice(0, 10),
                            )}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {!visible.length && (
                <div className="inline-empty">
                  <p>
                    {area === "roadmap"
                      ? "Define el próximo hito o prepara una versión para situar las entregas en el calendario."
                      : `No hay registros de ${kindLabels[area as DeliveryKind].toLowerCase()} en esta vista.`}
                  </p>
                </div>
              )}
              {visible.length > limit && (
                <button
                  className="secondary"
                  onClick={() => setLimit((n) => n + 100)}
                >
                  Mostrar 100 más
                </button>
              )}
            </>
          )}
          {area === "rules" && (
            <>
              <section className="planning-section">
                <div className="section-heading">
                  <h2>Reglas del proyecto</h2>
                  {["admin", "member"].includes(workspace.role) && (
                    <button
                      className="secondary"
                      onClick={() => props.legacyCreate("automation")}
                    >
                      Añadir regla
                    </button>
                  )}
                </div>
                {active
                  .filter((r) => r.kind === "automation")
                  .map((r) => (
                    <button
                      className="linked-row"
                      key={r.id}
                      onClick={() => open(r)}
                    >
                      {r.title}
                      <span>{r.data.enabled ? "Activa" : "Desactivada"}</span>
                    </button>
                  ))}
              </section>
              <AutomationHistory
                workspaceId={workspace.id}
                resources={active}
                open={open}
              />
            </>
          )}
          {area === "team" && (
            <section className="planning-section">
              <div className="section-heading">
                <h2>Equipos del espacio</h2>
                {canEdit && (
                  <button
                    className="secondary"
                    onClick={() => props.legacyCreate("team")}
                  >
                    Crear equipo
                  </button>
                )}
              </div>
              {active
                .filter((r) => r.kind === "team")
                .map((r) => (
                  <button
                    className="linked-row"
                    key={r.id}
                    onClick={() => open(r)}
                  >
                    {r.title}
                  </button>
                ))}
            </section>
          )}
        </>
      )}
      {editor && (
        <DeliveryEditor
          key={`editor-${editor.resource?.id || `new-${editor.kind}`}`}
          {...props}
          kind={editor.kind}
          resource={editor.resource}
          defaultProjectId={projectId}
          close={() => setEditor(null)}
          done={(resource) => {
            setEditor(null);
            if (resource) setFocus(resource.id);
            setNotice(
              "Planificación guardada en este dispositivo; pendiente de sincronización.",
            );
          }}
        />
      )}
    </section>
  );
}

function Roadmap({
  records,
  open,
}: {
  records: Resource[];
  open: (r: Resource) => void;
}) {
  const dated = records.filter(
    (r) =>
      validDay(r.data.startDate || r.data.dueDate) &&
      validDay(r.data.dueDate || r.data.endDate || r.data.startDate),
  );
  if (!dated.length)
    return (
      <p className="muted">
        Las entregas con fechas aparecerán aquí. Los elementos sin fecha se
        mantienen en la lista.
      </p>
    );
  const start = Math.min(
      ...dated.map((r) => Date.parse(r.data.startDate || r.data.dueDate)),
    ),
    end = Math.max(
      ...dated.map((r) =>
        Date.parse(r.data.dueDate || r.data.endDate || r.data.startDate),
      ),
    ),
    span = Math.max(86400000, end - start + 86400000),
    day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return (
    <div
      className="delivery-roadmap"
      role="region"
      aria-label="Calendario de entregas"
      tabIndex={0}
    >
      <div className="delivery-roadmap-inner">
        <div className="roadmap-header">
          <span>Entrega y periodo previsto</span>
          <div>
            {[
              ...new Set(
                [0, 0.25, 0.5, 0.75, 1].map((tick) =>
                  day(
                    start +
                      Math.floor(((end - start) * tick) / 86400000) * 86400000,
                  ),
                ),
              ),
            ].map((value) => (
              <span key={value}>{dateText(value)}</span>
            ))}
          </div>
        </div>
        {dated.map((resource) => {
          const from = Date.parse(
              resource.data.startDate || resource.data.dueDate,
            ),
            to = Date.parse(
              resource.data.dueDate ||
                resource.data.endDate ||
                resource.data.startDate,
            );
          return (
            <div className="roadmap-row" key={resource.id}>
              <button className="text-button" onClick={() => open(resource)}>
                {resource.title}
              </button>
              <div
                className="roadmap-track"
                role="img"
                aria-label={`${dateText(day(from))} a ${dateText(day(to))}`}
              >
                <span
                  className={`roadmap-window ${resource.data.deliveryReceipt ? "confirmed" : ""}`}
                  style={{
                    left: `${((from - start) / span) * 100}%`,
                    width: `${Math.max(0.7, ((to - from + 86400000) / span) * 100)}%`,
                  }}
                  title={`${resource.title}: ${dateText(day(from))} a ${dateText(day(to))}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeliveryDetail({
  resource,
  resources,
  members,
  canEdit,
  online,
  user,
  workspace,
  open,
  back,
  edit,
  refresh,
  discuss,
  save,
  run,
  confirmed,
}: {
  resource: Resource;
  resources: Resource[];
  members: Props["members"];
  canEdit: boolean;
  online: boolean;
  user: User;
  workspace: Workspace;
  open: Props["open"];
  back: () => void;
  edit: () => void;
  refresh: () => Promise<void>;
  discuss: () => void;
  save: Props["save"];
  run: (path: string, body: Record<string, any>) => Promise<any>;
  confirmed: () => Promise<void>;
}) {
  const [readiness, setReadiness] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const value = resource.data.delivery,
    receipt = resource.data.deliveryReceipt,
    stale =
      readiness &&
      (readiness.resource.version !== resource.version ||
        readiness.references.some(
          (r: Resource) =>
            resources.find((current) => current.id === r.id)?.version !==
            r.version,
        ));
  const linked = (ids: string[]) =>
    ids.map((id) => {
      const target = resources.find((r) => r.id === id);
      return target ? (
        <button className="linked-row" key={id} onClick={() => open(target)}>
          {target.title}
          <span>
            {deliveryStatusLabels[target.data.status] ||
              statusLabels[target.data.status] ||
              ""}
          </span>
        </button>
      ) : (
        <p className="muted" key={id}>
          Elemento no disponible
        </p>
      );
    });
  return (
    <section className="delivery-detail" aria-label="Detalle de planificación">
      <div className="collection-summary">
        <button className="text-button" onClick={back}>
          Volver a planificación
        </button>
        <div className="template-actions">
          {canEdit && !receipt && (
            <button className="secondary" onClick={edit}>
              Editar planificación
            </button>
          )}
          {canEdit && (
            <button
              className="text-button"
              onClick={async () => {
                try {
                  await refresh();
                  setReadiness(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Actualizar datos
            </button>
          )}
        </div>
      </div>
      <h2>{resource.title}</h2>
      <p>
        {kindLabels[resource.kind]} ·{" "}
        {deliveryStatusLabels[resource.data.status] || "Sin configurar"}
        {value?.version ? ` · ${value.version}` : ""}
        {resource.data.archived ? " · Archivado" : ""}
      </p>
      <p className="delivery-goal">{resource.data.goal}</p>
      <p className="delivery-description">{resource.data.description}</p>
      <dl className="delivery-facts">
        <div>
          <dt>Proyecto</dt>
          <dd>
            {resources.find((r) => r.id === resource.data.projectId)?.title ||
              "Sin proyecto"}
          </dd>
        </div>
        <div>
          <dt>Responsable</dt>
          <dd>
            {members.find((m) => m.id === resource.data.assigneeId)?.name ||
              "Sin asignar"}
          </dd>
        </div>
        <div>
          <dt>Inicio</dt>
          <dd>{dateText(resource.data.startDate)}</dd>
        </div>
        <div>
          <dt>Vencimiento</dt>
          <dd>{dateText(resource.data.dueDate)}</dd>
        </div>
      </dl>
      {resource.data.repository && (
        <p>
          <a href={resource.data.repository} target="_blank" rel="noreferrer">
            Abrir repositorio
          </a>
          {value?.tag ? ` · ${value.tag}` : ""}
        </p>
      )}
      {!value && (
        <p className="muted">
          Configura este registro para utilizar las comprobaciones y el
          historial de entregas.
        </p>
      )}
      {value?.type === "risk" && (
        <>
          <h3>Evaluación del riesgo</h3>
          <p
            className={value.probability * value.impact >= 15 ? "negative" : ""}
          >
            Probabilidad {value.probability}/5 × impacto {value.impact}/5 ={" "}
            {value.probability * value.impact}/25
          </p>
          <p>Próxima revisión: {dateText(value.reviewDate)}</p>
          <h3>Mitigación</h3>
          <p className="delivery-description">
            {value.mitigation || "Pendiente de definir"}
          </p>
          <h3>Contingencia</h3>
          <p className="delivery-description">
            {value.contingency || "Pendiente de definir"}
          </p>
          {value.dispositionReason && (
            <>
              <h3>Motivo de aceptación</h3>
              <p className="delivery-description">{value.dispositionReason}</p>
            </>
          )}
        </>
      )}
      {value?.type === "decision" && (
        <>
          <h3>Alternativas consideradas</h3>
          {value.options.map((option: any) => (
            <article className="decision-option" key={option.id}>
              <h4>
                {option.label}
                {option.id === value.chosenOptionId ? " · Elegida" : ""}
              </h4>
              <p className="delivery-description">{option.tradeoffs}</p>
            </article>
          ))}
          <h3>Motivo de la decisión</h3>
          <p className="delivery-description">
            {value.rationale || "Pendiente de documentar"}
          </p>
          {value.supersedesId && (
            <>
              <h3>Sustituye a</h3>
              {linked([value.supersedesId])}
            </>
          )}
          {value.supersededById && (
            <>
              <h3>Sustituida por</h3>
              {linked([value.supersededById])}
            </>
          )}
        </>
      )}
      {!!value?.taskIds?.length && (
        <>
          <h3>Tareas de alcance directo</h3>
          {linked(value.taskIds)}
        </>
      )}
      {!!value?.dependsOn?.length && (
        <>
          <h3>Depende de estos hitos</h3>
          {linked(value.dependsOn)}
        </>
      )}
      {!!value?.milestoneIds?.length && (
        <>
          <h3>Hitos incluidos</h3>
          {linked(value.milestoneIds)}
        </>
      )}
      {!!value?.riskIds?.length && (
        <>
          <h3>Riesgos de la entrega</h3>
          {linked(value.riskIds)}
        </>
      )}
      {value?.notes && (
        <>
          <h3>Notas de versión</h3>
          <p className="delivery-description">{value.notes}</p>
        </>
      )}
      {!!resource.data.checklist?.length && (
        <>
          <h3>Lista de comprobación</h3>
          <ul>
            {resource.data.checklist.map((item: any) => (
              <li key={item.id}>
                {item.done ? "Completado" : "Pendiente"} · {item.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {receipt ? (
        <section className="delivery-receipt">
          <h3>Confirmación conservada</h3>
          <p>
            {new Date(receipt.at).toLocaleString("es")} · versión{" "}
            {receipt.version} · {deliveryStatusLabels[receipt.finalStatus]}
          </p>
          <p>{receipt.note}</p>
          <p className="muted">
            Estas versiones, estados y estimaciones se conservaron al confirmar.
            Los cambios posteriores en las tareas o riesgos no reescriben esta
            fotografía.
          </p>
          <div className="receipt-list">
            {receipt.items.map((item: any) => (
              <article key={item.id}>
                <strong>{item.title}</strong>
                <span>
                  {kindLabels[item.kind as ResourceKind]} · v{item.version} ·{" "}
                  {deliveryStatusLabels[item.status] ||
                    statusLabels[item.status] ||
                    "Sin estado"}
                  {item.estimate !== undefined
                    ? ` · ${item.estimate} puntos`
                    : ""}
                  {item.riskScore ? ` · Riesgo ${item.riskScore}/25` : ""}
                </span>
                {item.summary && (
                  <p className="delivery-description">{item.summary}</p>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : (
        value &&
        value.type !== "risk" && (
          <section className="delivery-confirmation">
            <h3>Comprobaciones de entrega</h3>
            <p className="muted">
              La confirmación conserva el alcance y comprueba sus versiones en
              una transacción. Requiere conexión y todos los cambios locales
              sincronizados.
            </p>
            {canEdit && (
              <button
                className="secondary"
                disabled={busy || !online}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await flushOutbox(user.id, workspace.id, () => {});
                    await refresh();
                    setReadiness(
                      await api(
                        `/workspaces/${workspace.id}/planning/${resource.id}/readiness`,
                      ),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Comprobar entrega
              </button>
            )}
            {readiness && (
              <>
                {stale && (
                  <p role="alert">
                    El alcance cambió desde la comprobación. Actualízala antes
                    de confirmar.
                  </p>
                )}
                {readiness.issues.length > 0 ? (
                  <ul>
                    {readiness.issues.map((issue: any, index: number) => (
                      <li key={index}>{issue.message}</li>
                    ))}
                  </ul>
                ) : (
                  <p role="status">Todas las condiciones están satisfechas.</p>
                )}
                <p>
                  {readiness.references.length} elementos y contextos de
                  permisos comprobados.
                </p>
                <Field label="Nota de confirmación">
                  <textarea
                    value={note}
                    maxLength={100000}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                {canEdit && (
                  <button
                    className="primary"
                    disabled={busy || !online || stale || !readiness.ready}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await run(
                          `/workspaces/${workspace.id}/planning/${resource.id}/confirm`,
                          {
                            expectedVersion: readiness.resource.version,
                            expectedReferences: readiness.references.map(
                              (r: Resource) => ({
                                id: r.id,
                                version: r.version,
                              }),
                            ),
                            note,
                          },
                        );
                        setReadiness(null);
                        await confirmed();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {resource.kind === "milestone"
                      ? "Confirmar hito alcanzado"
                      : resource.kind === "release"
                        ? "Confirmar publicación"
                        : "Aceptar decisión"}
                  </button>
                )}
              </>
            )}
          </section>
        )
      )}
      {canEdit && (
        <div className="template-actions">
          <button
            className="text-button"
            onClick={async () => {
              try {
                await save({
                  ...resource,
                  data: { ...resource.data, archived: !resource.data.archived },
                });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {" "}
            {resource.data.archived
              ? "Desarchivar registro"
              : "Archivar registro"}
          </button>
        </div>
      )}
      <div className="template-actions">
        <ResourceLink id={resource.id} />
        <button className="secondary" onClick={discuss}>
          Comentarios e historial
        </button>
        {canEdit && (
          <button
            className="text-button"
            onClick={async () => {
              try {
                const current = (resource.data.followers || []) as string[];
                await save({
                  ...resource,
                  data: {
                    ...resource.data,
                    followers: current.includes(user.id)
                      ? current.filter((id) => id !== user.id)
                      : [...current, user.id],
                  },
                });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {(resource.data.followers || []).includes(user.id)
              ? "Dejar de seguir registro"
              : "Seguir registro"}
          </button>
        )}
      </div>
      <Attachments
        workspaceId={workspace.id}
        resourceId={resource.id}
        userId={user.id}
        editable={canEdit && !receipt}
        error={setError}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function DeliveryEditor(
  props: Props & {
    kind: DeliveryKind;
    resource: Resource | null;
    defaultProjectId: string;
    close: () => void;
    done: (resource: Resource | undefined) => void;
  },
) {
  const { kind, resource, resources, user, workspace, close } = props;
  const [title, setTitle] = useState(resource?.title || ""),
    [data, setData] = useState<Record<string, any>>({
      ...resource?.data,
      status:
        resource?.data.status &&
        deliveryStatuses[kind].includes(resource.data.status)
          ? resource.data.status
          : initialStatus(kind),
      projectId: resource?.data.projectId || props.defaultProjectId || "",
      delivery: resource?.data.delivery || defaultDelivery(kind),
    }),
    [baseVersion, setBaseVersion] = useState(resource?.version || 0),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draft = useSprintDraft(
    user.id,
    `${workspace.id}:delivery:${resource?.id || `new-${kind}`}`,
    { title, data, baseVersion },
    dirty,
    (value) => {
      if (
        typeof value.title !== "string" ||
        !Number.isInteger(value.baseVersion) ||
        !deliverySchema.safeParse(value.data?.delivery).success ||
        value.data?.delivery?.type !== kind ||
        !resourceDataSchema.safeParse({
          ...value.data,
          projectId: value.data?.projectId || undefined,
        }).success
      )
        throw new Error("Invalid delivery draft");
      setTitle(value.title);
      setData(value.data);
      setBaseVersion(value.baseVersion);
      setDirty(true);
    },
  );
  const set = (patch: Record<string, any>) => {
      setDirty(true);
      setData((d) => ({ ...d, ...patch }));
    },
    change = (patch: Record<string, any>) =>
      set({ delivery: { ...data.delivery, ...patch } }),
    value = data.delivery;
  const projects = resources.filter(
      (r) => r.kind === "project" && !r.deleted_at && !r.data.archived,
    ),
    scoped = resources.filter(
      (r) =>
        !r.deleted_at &&
        r.id !== resource?.id &&
        belongsToProject(r, data.projectId, resources),
    );
  const selectRefs = (label: string, field: string, type: ResourceKind) => (
    <Field label={label}>
      <select
        multiple
        size={Math.min(
          6,
          Math.max(2, scoped.filter((r) => r.kind === type).length),
        )}
        value={value[field] || []}
        onChange={(e) =>
          change({ [field]: [...e.target.selectedOptions].map((o) => o.value) })
        }
      >
        {scoped
          .filter((r) => r.kind === type)
          .map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
      </select>
    </Field>
  );
  const leave = () => {
    if (
      !dirty ||
      confirm(
        "El borrador quedará conservado en este dispositivo. ¿Cerrar el editor?",
      )
    )
      close();
  };
  return (
    <Modal
      title={`${resource ? "Editar" : "Crear"} ${kindLabels[kind].toLowerCase()}`}
      close={() => {
        if (!busy) leave();
      }}
      className="delivery-modal"
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            deliverySchema.parse(data.delivery);
            const issue = deliveryDraftIssues(data)[0];
            if (issue) throw new Error(issue);
            if (
              new TextEncoder().encode(JSON.stringify({ title, data }))
                .byteLength >
              900 * 1024
            )
              throw new Error(
                "El borrador supera 900 KiB. Reduce su contenido antes de guardarlo.",
              );
            if (!data.projectId) throw new Error("Elige un proyecto.");
            if (kind === "release" && data.status === "ready") {
              const issue = localDeliveryReadinessIssues(
                {
                  ...resource,
                  id: resource?.id || "new",
                  kind,
                  data,
                } as Resource,
                resources,
              )[0];
              if (issue) throw new Error(issue.message);
            }
            const result = resource
              ? await props.save({
                  ...resource,
                  title,
                  data,
                  version: baseVersion,
                })
              : await props.create(kind, title, data);
            await draft.clear();
            props.done(result);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {draft.issue && (
          <p className="error" role="alert">
            {draft.issue}
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
        <fieldset className="template-fieldset" disabled={!draft.ready || busy}>
          <Field label="Título de planificación">
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
          <div className="collection-filters">
            <Field label="Proyecto del registro">
              <select
                required
                value={data.projectId}
                onChange={(e) => set({ projectId: e.target.value })}
              >
                <option value="">Elige un proyecto</option>
                {projects.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estado de planificación">
              <select
                value={data.status}
                onChange={(e) => set({ status: e.target.value })}
              >
                {deliveryStatuses[kind]
                  .filter(
                    (status) =>
                      kind === "risk" ||
                      ![
                        "achieved",
                        "released",
                        "accepted",
                        "superseded",
                      ].includes(status),
                  )
                  .map((status) => (
                    <option key={status} value={status}>
                      {deliveryStatusLabels[status]}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Responsable de planificación">
              <select
                value={data.assigneeId || ""}
                onChange={(e) => set({ assigneeId: e.target.value || null })}
              >
                <option value="">Sin asignar</option>
                {props.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fecha de inicio">
              <input
                type="date"
                value={data.startDate || ""}
                onChange={(e) => set({ startDate: e.target.value })}
              />
            </Field>
            <Field label="Fecha límite de planificación">
              <input
                type="date"
                value={data.dueDate || ""}
                onChange={(e) => set({ dueDate: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Objetivo de la entrega">
            <textarea
              value={data.goal || ""}
              maxLength={100000}
              onChange={(e) => set({ goal: e.target.value })}
            />
          </Field>
          <Field label="Contexto de planificación">
            <textarea
              value={data.description || ""}
              maxLength={100000}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          {kind === "milestone" && (
            <>
              {selectRefs("Tareas del hito", "taskIds", "task")}
              {selectRefs("Hitos previos necesarios", "dependsOn", "milestone")}
            </>
          )}
          {kind === "release" && (
            <>
              <div className="collection-filters">
                <Field label="Identificador de versión">
                  <input
                    required
                    maxLength={80}
                    value={value.version}
                    onChange={(e) => change({ version: e.target.value })}
                  />
                </Field>
                <Field label="Etiqueta del repositorio">
                  <input
                    maxLength={100}
                    value={value.tag}
                    onChange={(e) => change({ tag: e.target.value })}
                  />
                </Field>
                <Field label="Enlace del repositorio">
                  <input
                    type="url"
                    placeholder="https://…"
                    value={data.repository || ""}
                    onChange={(e) => set({ repository: e.target.value })}
                  />
                </Field>
              </div>
              {selectRefs("Tareas directas de la versión", "taskIds", "task")}
              {selectRefs("Hitos de la versión", "milestoneIds", "milestone")}
              {selectRefs("Riesgos de la versión", "riskIds", "risk")}
              <Field label="Notas de publicación">
                <textarea
                  value={value.notes}
                  maxLength={100000}
                  onChange={(e) => change({ notes: e.target.value })}
                />
              </Field>
            </>
          )}
          {kind === "risk" && (
            <>
              <div className="collection-filters">
                <Field label="Probabilidad del riesgo">
                  <input
                    type="number"
                    min={1}
                    max={5}
                    required
                    value={value.probability}
                    onChange={(e) =>
                      change({ probability: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="Impacto del riesgo">
                  <input
                    type="number"
                    min={1}
                    max={5}
                    required
                    value={value.impact}
                    onChange={(e) => change({ impact: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Próxima revisión del riesgo">
                  <input
                    type="date"
                    value={value.reviewDate}
                    onChange={(e) => change({ reviewDate: e.target.value })}
                  />
                </Field>
              </div>
              <p>Valoración: {value.probability * value.impact}/25</p>
              <Field label="Medidas de mitigación">
                <textarea
                  value={value.mitigation}
                  maxLength={100000}
                  onChange={(e) => change({ mitigation: e.target.value })}
                />
              </Field>
              <Field label="Plan de contingencia">
                <textarea
                  value={value.contingency}
                  maxLength={100000}
                  onChange={(e) => change({ contingency: e.target.value })}
                />
              </Field>
              <Field label="Motivo para aceptar el riesgo">
                <textarea
                  value={value.dispositionReason}
                  maxLength={100000}
                  onChange={(e) =>
                    change({ dispositionReason: e.target.value })
                  }
                />
              </Field>
            </>
          )}
          {kind === "decision" && (
            <>
              <h3>Alternativas</h3>
              {value.options.map((option: any, index: number) => (
                <section className="decision-option" key={option.id}>
                  <Field label={`Alternativa ${index + 1}`}>
                    <input
                      value={option.label}
                      maxLength={500}
                      required
                      onChange={(e) =>
                        change({
                          options: value.options.map((o: any) =>
                            o.id === option.id
                              ? { ...o, label: e.target.value }
                              : o,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={`Ventajas y costes de alternativa ${index + 1}`}
                  >
                    <textarea
                      value={option.tradeoffs}
                      maxLength={100000}
                      onChange={(e) =>
                        change({
                          options: value.options.map((o: any) =>
                            o.id === option.id
                              ? { ...o, tradeoffs: e.target.value }
                              : o,
                          ),
                        })
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      change({
                        options: value.options.filter(
                          (o: any) => o.id !== option.id,
                        ),
                        chosenOptionId:
                          value.chosenOptionId === option.id
                            ? undefined
                            : value.chosenOptionId,
                      })
                    }
                  >
                    Quitar alternativa {index + 1}
                  </button>
                </section>
              ))}
              <button
                type="button"
                className="secondary"
                disabled={value.options.length >= 20}
                onClick={() =>
                  change({
                    options: [
                      ...value.options,
                      { id: crypto.randomUUID(), label: "", tradeoffs: "" },
                    ],
                  })
                }
              >
                Añadir alternativa
              </button>
              <Field label="Alternativa elegida">
                <select
                  value={value.chosenOptionId || ""}
                  onChange={(e) =>
                    change({ chosenOptionId: e.target.value || undefined })
                  }
                >
                  <option value="">Pendiente de elegir</option>
                  {value.options.map((o: any) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Motivo de la decisión">
                <textarea
                  value={value.rationale}
                  maxLength={100000}
                  onChange={(e) => change({ rationale: e.target.value })}
                />
              </Field>
              <Field label="Decisión aceptada a sustituir">
                <select
                  value={value.supersedesId || ""}
                  onChange={(e) =>
                    change({ supersedesId: e.target.value || undefined })
                  }
                >
                  <option value="">No sustituye una decisión previa</option>
                  {scoped
                    .filter(
                      (r) =>
                        r.kind === "decision" && r.data.status === "accepted",
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                </select>
              </Field>
            </>
          )}
          <h3>Comprobaciones</h3>
          {(data.checklist || []).map((item: any, index: number) => (
            <div className="delivery-check" key={item.id}>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={item.done}
                  aria-label={`Completar comprobación ${index + 1}`}
                  onChange={(e) =>
                    set({
                      checklist: data.checklist.map((c: any) =>
                        c.id === item.id ? { ...c, done: e.target.checked } : c,
                      ),
                    })
                  }
                />
                <span>{index + 1}</span>
              </label>
              <input
                aria-label={`Texto de comprobación ${index + 1}`}
                value={item.text}
                maxLength={500}
                required
                onChange={(e) =>
                  set({
                    checklist: data.checklist.map((c: any) =>
                      c.id === item.id ? { ...c, text: e.target.value } : c,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="text-button"
                aria-label={`Quitar comprobación ${index + 1}`}
                onClick={() =>
                  set({
                    checklist: data.checklist.filter(
                      (c: any) => c.id !== item.id,
                    ),
                  })
                }
              >
                Quitar
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={(data.checklist || []).length >= 300}
            onClick={() =>
              set({
                checklist: [
                  ...(data.checklist || []),
                  { id: crypto.randomUUID(), text: "", done: false },
                ],
              })
            }
          >
            Añadir comprobación
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="template-actions">
            <button className="primary" disabled={!!draft.issue}>
              Guardar planificación
            </button>
            {draft.saved && (
              <span role="status" className="muted">
                Borrador de planificación conservado en este dispositivo.
              </span>
            )}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
