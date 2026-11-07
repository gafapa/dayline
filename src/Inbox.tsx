import { useEffect, useRef, useState } from "react";
import { Archive, ArrowUpRight, Bell, CalendarCheck, Clock3, FileText, Inbox as InboxIcon, ListTodo } from "lucide-react";
import type { Resource, User } from "../shared/model";
import { kindLabels } from "../shared/model";
import { stateLabel } from "../shared/workflow";
import { Empty } from "./ui-common";
import { isSnoozed, triage } from "./triage";

const when = (iso: string) =>
  new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const dayText = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" }).format(new Date(y, m - 1, d));
};
type Queue = "pending" | "later" | "earlier";
type KindFilter = "all" | "task" | "document" | "other";

/**
 * Inbox as a triage queue in master–detail: the list on the left, the selected notice on the
 * right with its context and the decisions (plan it, open it, snooze it, archive it).
 * Keys inside the list: J/K move, H plans for today, P snoozes, E archives, Enter opens.
 */
export default function Inbox({
  resources,
  user,
  save,
  open,
}: {
  resources: Resource[];
  user: User;
  save: (resource: Resource) => Promise<unknown>;
  open: (resource: Resource) => void;
}) {
  const [queue, setQueue] = useState<Queue>("pending");
  const [kind, setKind] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** "Archivar todo" asks once more before clearing the visible queue. */
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => setConfirmAll(false), [queue, kind]);
  const detailRef = useRef<HTMLElement>(null);
  const t = triage(resources, user, save);
  const projects = resources.filter((r) => r.kind === "project" && !r.deleted_at);
  const mine = resources
    .filter((r) => r.kind === "notification" && !r.deleted_at && r.data.assigneeId === user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const queues: Record<Queue, Resource[]> = {
    pending: mine.filter((r) => !r.data.read && !isSnoozed(r)),
    later: mine.filter((r) => !r.data.read && isSnoozed(r)),
    earlier: mine.filter((r) => r.data.read),
  };
  const kindOf = (r: Resource): KindFilter => {
    const k = t.target(r)?.kind;
    return k === "task" || k === "document" ? k : "other";
  };
  const list = queues[queue].filter((r) => kind === "all" || kindOf(r) === kind);
  const selected = list.find((r) => r.id === selectedId) || list[0];
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected?.id]);

  const move = (step: number) => {
    if (!list.length) return;
    const index = Math.max(0, list.findIndex((r) => r.id === selected?.id));
    setSelectedId(list[Math.min(list.length - 1, Math.max(0, index + step))].id);
  };
  /** After a decision the next notice is selected, so the queue can be worked through. */
  const decide = async (action: (r: Resource) => Promise<unknown>) => {
    if (!selected) return;
    const index = list.findIndex((r) => r.id === selected.id);
    const next = list[index + 1] || list[index - 1];
    await action(selected);
    setSelectedId(next?.id || null);
  };
  const openTarget = (r: Resource) => {
    const item = t.target(r);
    if (!item) return;
    open(item);
    if (!r.data.read) void t.archive(r);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "j" || e.key === "ArrowDown") move(1);
    else if (key === "k" || e.key === "ArrowUp") move(-1);
    else if (key === "h" && selected && t.plannable(selected)) void decide(t.planToday);
    else if (key === "p" && selected && queue === "pending") void decide(t.snooze);
    else if (key === "e" && selected && !selected.data.read) void decide(t.archive);
    else if (e.key === "Enter" && selected) openTarget(selected);
    else return;
    e.preventDefault();
  };

  if (!mine.length)
    return (
      <Empty
        icon={InboxIcon}
        title="Todo al día"
        description="Aquí llegan asignaciones, menciones, revisiones y avisos. Decide qué hacer con cada uno."
      />
    );
  const item = selected ? t.target(selected) : undefined;
  const project = item ? projects.find((p) => p.id === (item.kind === "project" ? item.id : item.data.projectId)) : undefined;
  const sprint = item?.data.sprintId ? resources.find((r) => r.id === item.data.sprintId) : undefined;
  const KindIcon = (r: Resource) => (kindOf(r) === "task" ? ListTodo : kindOf(r) === "document" ? FileText : Bell);
  const queueLabels: [Queue, string][] = [
    ["pending", "Por decidir"],
    ["later", "Pospuestos"],
    ["earlier", "Anteriores"],
  ];
  return (
    <div className="triage" onKeyDown={onKey}>
      <div className="page-toolbar">
        <div className="segmented" role="group" aria-label="Cola de la bandeja">
          {queueLabels.map(([key, label]) => (
            <button key={key} aria-pressed={queue === key} onClick={() => setQueue(key)}>
              {label} · {queues[key].length}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Tipo de aviso">
          {(
            [
              ["all", "Todo"],
              ["task", "Tareas"],
              ["document", "Documentos"],
              ["other", "Otros"],
            ] as [KindFilter, string][]
          ).map(([key, label]) => (
            <button key={key} aria-pressed={kind === key} onClick={() => setKind(key)}>
              {label}
            </button>
          ))}
        </div>
        {queue !== "earlier" && list.length > 1 && (
          <div className="triage-bulk push-end">
            {confirmAll ? (
              <>
                <button
                  className="danger"
                  onClick={async () => {
                    setConfirmAll(false);
                    for (const r of list) await t.archive(r);
                  }}
                >
                  Archivar {list.length} avisos
                </button>
                <button className="text-button" onClick={() => setConfirmAll(false)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button className="text-button" onClick={() => setConfirmAll(true)}>
                Archivar todo
              </button>
            )}
          </div>
        )}
        <span className="triage-keys muted" aria-hidden="true">
          <kbd>J</kbd>
          <kbd>K</kbd> moverse · <kbd>H</kbd> hoy · <kbd>P</kbd> posponer · <kbd>E</kbd> archivar
        </span>
      </div>
      {!list.length ? (
        <p className="muted triage-empty">
          <Bell size={14} />{" "}
          {queue === "pending" ? "Nada pendiente. Bien hecho." : queue === "later" ? "Nada pospuesto." : "Aún no hay avisos archivados."}
        </p>
      ) : (
        <div className="triage-layout">
          <section className="triage-list" aria-label="Avisos">
            {list.map((r) => {
              const Icon = KindIcon(r);
              return (
                <button
                  key={r.id}
                  className={`triage-item ${r.data.read ? "done" : ""}`}
                  aria-current={r.id === selected?.id ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(r.id);
                    // Stacked on a phone: bring the decision into view.
                    if (window.innerWidth < 900)
                      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
                  }}
                >
                  <span className={`triage-icon kind-${kindOf(r)}`}>
                    <Icon size={15} />
                  </span>
                  <span className="triage-text">
                    <strong>{r.title}</strong>
                    {r.data.description && <small>{r.data.description}</small>}
                  </span>
                  <small className="triage-when">
                    {isSnoozed(r) ? `vuelve ${when(r.data.snoozedUntil)}` : when(r.created_at)}
                  </small>
                </button>
              );
            })}
          </section>
          {selected && (
            <section ref={detailRef} className="triage-detail" aria-label="Aviso seleccionado">
              <span className="muted triage-detail-meta">
                {item ? kindLabels[item.kind] : "Aviso"} · {when(selected.created_at)}
              </span>
              <h2>{item?.title || selected.title}</h2>
              {item && <p className="triage-detail-reason">{selected.title}</p>}
              {item && (
                <dl className="triage-facts">
                  {project && (
                    <div>
                      <dt>Proyecto</dt>
                      <dd>{project.title}</dd>
                    </div>
                  )}
                  {item.kind === "task" && (
                    <div>
                      <dt>Estado</dt>
                      <dd>{stateLabel(item, projects)}</dd>
                    </div>
                  )}
                  {item.data.dueDate && (
                    <div>
                      <dt>Vence</dt>
                      <dd>{dayText(item.data.dueDate)}</dd>
                    </div>
                  )}
                  {sprint && (
                    <div>
                      <dt>Sprint</dt>
                      <dd>{sprint.title}</dd>
                    </div>
                  )}
                  {typeof item.data.estimate === "number" && (
                    <div>
                      <dt>Estimación</dt>
                      <dd>{item.data.estimate} puntos</dd>
                    </div>
                  )}
                </dl>
              )}
              {item?.data.description && <p className="triage-detail-body">{item.data.description}</p>}
              <div className="triage-actions">
                {t.plannable(selected) && (
                  <button className="primary" onClick={() => void decide(t.planToday)}>
                    <CalendarCheck size={15} />
                    Planificar para hoy
                  </button>
                )}
                {item && (
                  <button className={t.plannable(selected) ? "" : "primary"} onClick={() => openTarget(selected)}>
                    <ArrowUpRight size={15} />
                    Abrir
                  </button>
                )}
                {!selected.data.read && !isSnoozed(selected) && (
                  <button onClick={() => void decide(t.snooze)}>
                    <Clock3 size={15} />
                    Posponer a mañana
                  </button>
                )}
                {!selected.data.read && (
                  <button onClick={() => void decide(t.archive)}>
                    <Archive size={15} />
                    Archivar
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
