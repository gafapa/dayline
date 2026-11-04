import { Circle, CircleCheck, CircleDot, Plus, Search, X, Clock3 } from "lucide-react";
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
export function StatusIcon({ status }: { status: string }) {
  const Icon =
    status === "done"
      ? CircleCheck
      : status === "in_progress"
        ? CircleDot
        : status === "review"
          ? Clock3
          : Circle;
  return <Icon className={`status-icon ${status}`} size={17} />;
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
export function Empty({ icon: Icon, title, description, action, onAction }: any) {
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
