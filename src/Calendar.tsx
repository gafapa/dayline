import { useDrag, useDrop } from "./dnd";
import { useState, type ReactNode } from "react";
import { type Resource } from "../shared/model";
import { dateText } from "./ui-common";

/**
 * Month or week view of dated work: tasks (drag to reschedule), your reminders with their time,
 * and sprint start and end markers.
 */
export function Calendar({ tasks, open, save, canEdit, reminders = [], sprints = [] }: any) {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [mode, setMode] = useState<"month" | "week">("month");
  const [expanded, setExpanded] = useState<string | null>(null);
  const LIMIT = 4;
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  });
  const start = mode === "week" ? new Date(weekStart) : new Date(month);
  if (mode === "month") start.setDate(1 - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: mode === "week" ? 7 : 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const reschedule = async (task: Resource, day: string | null) => {
    if ((task.data.dueDate || null) === day) return;
    const { dueDate: _previous, ...rest } = task.data;
    await save({ ...task, data: day ? { ...rest, dueDate: day } : rest });
  };
  const today = iso(new Date());
  const shift = (step: number) => {
    if (mode === "week") {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + step * 7);
      setWeekStart(d);
    } else setMonth(new Date(month.getFullYear(), month.getMonth() + step, 1));
  };
  const remindersOn = (day: string) =>
    reminders
      .filter((r: Resource) => r.data.reminder?.at && iso(new Date(r.data.reminder.at)) === day)
      .sort((a: Resource, b: Resource) => a.data.reminder.at.localeCompare(b.data.reminder.at));
  const sprintMarks = (day: string) =>
    sprints.flatMap((s: Resource) => [
      ...(s.data.startDate === day ? [{ id: `${s.id}:start`, label: `Inicio · ${s.title}`, sprint: s }] : []),
      ...(s.data.endDate === day ? [{ id: `${s.id}:end`, label: `Fin · ${s.title}`, sprint: s }] : []),
    ]);
  return (
    <>
      <div className="calendar-heading">
        <h2>
          {mode === "week"
            ? `Semana del ${weekStart.toLocaleDateString("es", { day: "numeric", month: "long" })}`
            : month.toLocaleDateString("es", { month: "long", year: "numeric" })}
        </h2>
        <div className="calendar-mode" role="group" aria-label="Vista del calendario">
          {(["week", "month"] as const).map((value) => (
            <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
              {value === "week" ? "Semana" : "Mes"}
            </button>
          ))}
        </div>
        <div>
          <button
            aria-label={mode === "week" ? "Semana anterior" : "Mes anterior"}
            onClick={() => shift(-1)}
          >
            ←
          </button>
          <button
            onClick={() => {
              const now = new Date();
              setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
              const week = new Date(now);
              week.setHours(0, 0, 0, 0);
              week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
              setWeekStart(week);
            }}
          >
            Hoy
          </button>
          <button
            aria-label={mode === "week" ? "Semana siguiente" : "Mes siguiente"}
            onClick={() => shift(1)}
          >
            →
          </button>
        </div>
      </div>
      <div className={`calendar-grid ${mode === "week" ? "week" : ""}`}>
        {[
          "Lunes",
          "Martes",
          "Miércoles",
          "Jueves",
          "Viernes",
          "Sábado",
          "Domingo",
        ].map((d) => (
          <div className="calendar-weekday" key={d}>
            {d}
          </div>
        ))}
        {days.map((d) => (
          <CalendarDay
            key={iso(d)}
            day={iso(d)}
            className={`calendar-day ${mode === "month" && d.getMonth() !== month.getMonth() ? "other-month" : ""} ${iso(d) === today ? "today" : ""}`}
            canEdit={canEdit}
            reschedule={reschedule}
          >
            <span>{d.getDate()}</span>
            {(() => {
              const day = iso(d);
              const items: ReactNode[] = [
                ...sprintMarks(day).map((m: any) => (
                  <button key={m.id} className="calendar-chip sprint" onClick={() => open(m.sprint)}>
                    {m.label}
                  </button>
                )),
                ...remindersOn(day).map((r: Resource) => (
                  <button key={r.id} className="calendar-chip reminder" onClick={() => open(r)}>
                    {new Date(r.data.reminder.at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}{" "}
                    {r.title}
                  </button>
                )),
                ...tasks
                  .filter((t: Resource) => t.data.dueDate === day)
                  .map((t: Resource) => (
                    <CalendarTask
                      key={t.id}
                      task={t}
                      open={open}
                      canEdit={canEdit}
                      tone={
                        t.data.status === "done" || t.data.status === "cancelled"
                          ? "done"
                          : day < today
                            ? "late"
                            : "task"
                      }
                    />
                  )),
              ];
              const all = mode === "week" || expanded === day;
              return (
                <>
                  {all ? items : items.slice(0, LIMIT)}
                  {items.length > LIMIT && mode === "month" && (
                    <button
                      className="calendar-more"
                      aria-expanded={expanded === day}
                      onClick={() => setExpanded(expanded === day ? null : day)}
                    >
                      {expanded === day ? "Mostrar menos" : `+${items.length - LIMIT} más`}
                    </button>
                  )}
                </>
              );
            })()}
          </CalendarDay>
        ))}
      </div>
      {canEdit && (
        <CalendarDay
          day={null}
          className="calendar-undated"
          canEdit={canEdit}
          reschedule={reschedule}
        >
          <h3>Sin fecha</h3>
          <p className="muted">
            Arrastra una tarea a un día para darle fecha, o suéltala aquí para
            quitársela.
          </p>
          <div>
            {tasks
              .filter(
                (t: Resource) =>
                  !t.data.dueDate && !["done", "cancelled"].includes(t.data.status),
              )
              .slice(0, 30)
              .map((t: Resource) => (
                <CalendarTask key={t.id} task={t} open={open} canEdit={canEdit} />
              ))}
          </div>
        </CalendarDay>
      )}
      <h3 className="calendar-mobile-title">Tareas con fecha</h3>
      <div className="calendar-agenda">
        {tasks
          .filter((t: Resource) => t.data.dueDate)
          .sort((a: Resource, b: Resource) =>
            a.data.dueDate.localeCompare(b.data.dueDate),
          )
          .map((t: Resource) => (
            <button key={t.id} onClick={() => open(t)}>
              <span>{dateText(t.data.dueDate)}</span>
              {t.title}
            </button>
          ))}
      </div>
    </>
  );
}
/** A calendar cell (or the undated tray when `day` is null) that accepts dropped tasks. */
export function CalendarDay({
  day,
  className,
  canEdit,
  reschedule,
  children,
}: {
  day: string | null;
  className: string;
  canEdit: boolean;
  reschedule: (task: Resource, day: string | null) => Promise<void>;
  children: ReactNode;
}) {
  const drop = useDrop(
    `day:${day || "none"}`,
    {
      accepts: (item) => item.type === "task",
      drop: async (item) => {
        if (item.type === "task") await reschedule(item.task, day);
      },
    },
    !canEdit,
  );
  return (
    <div
      ref={drop.ref}
      className={`${className} ${drop.over ? "drop-over" : ""}`}
      aria-label={day ? undefined : "Tareas sin fecha"}
    >
      {children}
    </div>
  );
}
export function CalendarTask({
  task,
  open,
  canEdit,
  tone = "task",
}: {
  task: Resource;
  open: (task: Resource) => void;
  canEdit: boolean;
  tone?: "task" | "late" | "done";
}) {
  const drag = useDrag(
    `calendar:${task.id}`,
    { type: "task", task, label: task.title },
    !canEdit,
  );
  return (
    <button
      ref={drag.ref}
      className={`calendar-chip ${tone} ${drag.dragging ? "dragging" : ""}`}
      onClick={() => open(task)}
      {...drag.handle}
    >
      {task.title}
    </button>
  );
}
