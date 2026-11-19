import { Plus, Search, X } from "lucide-react";
import { sprintStats, type Resource } from "../shared/model";

export const dateText = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(
        new Date(value),
      )
    : "Sin fecha";

export function SprintProgress({ tasks }: { tasks: Resource[] }) {
  const stats = sprintStats(tasks);
  return (
    <>
      <div className="progress-track">
        <span style={{ width: `${stats.percent}%` }} />
      </div>
      <div className="project-footer">
        <span>
          {stats.done} de {stats.total} tareas completadas
        </span>
        <span>{stats.percent}%</span>
      </div>
    </>
  );
}
/**
 * A task state as a small circle: dashed for the backlog, empty to do, half and three quarters
 * filled in progress and in review, a check when done and a cross when cancelled.
 */
export function StatusIcon({
  status,
  size = 16,
}: {
  status: string;
  size?: number;
}) {
  const ring = {
    cx: 8,
    cy: 8,
    r: 6.25,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
  };
  return (
    <svg
      className={`status-icon ${status}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {status === "backlog" ? (
        <circle {...ring} strokeDasharray="2.6 2.1" />
      ) : status === "done" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.2 7 10.2 11 6"
            fill="none"
            stroke="var(--surface)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : status === "cancelled" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
            stroke="var(--surface)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle {...ring} />
          {status === "in_progress" && (
            <path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" />
          )}
          {status === "review" && (
            <path d="M8 4a4 4 0 1 1-4 4h4z" fill="currentColor" />
          )}
        </>
      )}
    </svg>
  );
}

export function SearchField({
  value,
  set,
  autoFocus = false,
}: {
  value: string;
  set: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="search-field">
      <Search size={15} />
      <input
        aria-label="Buscar"
        placeholder="Buscar…"
        value={value}
        onChange={(e) => set(e.target.value)}
        autoFocus={autoFocus}
      />
      {value && (
        <button aria-label="Vaciar búsqueda" onClick={() => set("")}>
          <X size={13} />
        </button>
      )}
    </label>
  );
}
export function Empty({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: any) {
  return (
    <div className="empty-state">
      <Icon size={34} strokeWidth={1.3} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action && (
        <button onClick={onAction}>
          <Plus size={16} />
          {action}
        </button>
      )}
    </div>
  );
}
export function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
