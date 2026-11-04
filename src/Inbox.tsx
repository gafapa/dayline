import { useState } from "react";
import { Bell, CalendarCheck, Clock3, Archive, ArrowUpRight, Inbox as InboxIcon } from "lucide-react";
import type { Resource, User } from "../shared/model";
import { kindLabels } from "../shared/model";
import { Empty } from "./ui-common";

const localDay = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const tomorrowMorning = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};
const when = (iso: string) =>
  new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/**
 * Inbox as a triage queue: every notification gets a decision (plan it, open it,
 * snooze it or archive it) instead of just being marked read.
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
  const [showEarlier, setShowEarlier] = useState(false);
  const now = Date.now();
  const mine = resources
    .filter((r) => r.kind === "notification" && !r.deleted_at && r.data.assigneeId === user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const snoozed = (r: Resource) => !!r.data.snoozedUntil && Date.parse(r.data.snoozedUntil) > now;
  const pending = mine.filter((r) => !r.data.read && !snoozed(r)),
    later = mine.filter((r) => !r.data.read && snoozed(r)),
    earlier = mine.filter((r) => r.data.read);
  const target = (r: Resource) =>
    r.data.targetId ? resources.find((t) => t.id === r.data.targetId && !t.deleted_at) : undefined;
  const archive = (r: Resource) => save({ ...r, data: { ...r.data, read: true } });
  const actions = (r: Resource) => {
    const item = target(r);
    const plannable =
      item?.kind === "task" &&
      item.data.assigneeId === user.id &&
      !["done", "cancelled"].includes(item.data.status) &&
      item.data.dueDate !== localDay();
    return (
      <div className="triage-actions">
        {plannable && (
          <button
            className="primary"
            onClick={async () => {
              await save({ ...item!, data: { ...item!.data, dueDate: localDay() } });
              await archive(r);
            }}
          >
            <CalendarCheck size={15} />
            Planificar para hoy
          </button>
        )}
        {item && (
          <button
            className={plannable ? "" : "primary"}
            onClick={() => {
              open(item);
              if (!r.data.read) void archive(r);
            }}
          >
            <ArrowUpRight size={15} />
            Abrir
          </button>
        )}
        {!r.data.read && !snoozed(r) && (
          <button onClick={() => save({ ...r, data: { ...r.data, snoozedUntil: tomorrowMorning() } })}>
            <Clock3 size={15} />
            Posponer a mañana
          </button>
        )}
        {!r.data.read && (
          <button onClick={() => archive(r)}>
            <Archive size={15} />
            Archivar
          </button>
        )}
      </div>
    );
  };
  const row = (r: Resource) => {
    const item = target(r);
    return (
      <article className={`triage-item ${r.data.read ? "done" : ""}`} key={r.id}>
        <span className={`triage-kind kind-${item?.kind || "none"}`}>
          {item ? kindLabels[item.kind] : "Aviso"}
        </span>
        <div className="triage-text">
          <strong>{r.title}</strong>
          {r.data.description && <p>{r.data.description}</p>}
          <small>
            {when(r.created_at)}
            {snoozed(r) ? ` · vuelve ${when(r.data.snoozedUntil)}` : ""}
          </small>
        </div>
        {actions(r)}
      </article>
    );
  };
  if (!mine.length)
    return (
      <Empty
        icon={InboxIcon}
        title="Todo al día"
        description="Aquí llegan asignaciones, menciones, revisiones y avisos. Decide qué hacer con cada uno."
      />
    );
  return (
    <div className="triage">
      <section aria-labelledby="triage-pending">
        <h2 id="triage-pending" className="triage-heading">
          Por decidir <span>{pending.length}</span>
        </h2>
        {pending.length ? (
          pending.map(row)
        ) : (
          <p className="muted triage-empty">
            <Bell size={14} /> Nada pendiente. Bien hecho.
          </p>
        )}
      </section>
      {later.length > 0 && (
        <section aria-labelledby="triage-later">
          <h2 id="triage-later" className="triage-heading">
            Pospuestos <span>{later.length}</span>
          </h2>
          {later.map(row)}
        </section>
      )}
      {earlier.length > 0 && (
        <section aria-labelledby="triage-earlier">
          <button className="text-button" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
            {showEarlier ? "Ocultar anteriores" : `Ver anteriores (${earlier.length})`}
          </button>
          {showEarlier && earlier.map(row)}
        </section>
      )}
    </div>
  );
}
