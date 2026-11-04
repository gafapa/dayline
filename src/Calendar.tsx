import { useDrag, useDrop } from "./dnd";
import { useState, type ReactNode } from "react";
import { type Resource } from "../shared/model";
import { dateText } from "./ui-common";

export function Calendar({ tasks, open, save, canEdit }: any) {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const start = new Date(month);
  start.setDate(1 - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => {
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
  return (
    <>
      <div className="calendar-heading">
        <h2>
          {month.toLocaleDateString("es", { month: "long", year: "numeric" })}
        </h2>
        <div>
          <button
            aria-label="Mes anterior"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            ←
          </button>
          <button
            onClick={() =>
              setMonth(
                new Date(new Date().getFullYear(), new Date().getMonth(), 1),
              )
            }
          >
            Hoy
          </button>
          <button
            aria-label="Mes siguiente"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            →
          </button>
        </div>
      </div>
      <div className="calendar-grid">
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
            className={`calendar-day ${d.getMonth() !== month.getMonth() ? "other-month" : ""} ${iso(d) === iso(new Date()) ? "today" : ""}`}
            canEdit={canEdit}
            reschedule={reschedule}
          >
            <span>{d.getDate()}</span>
            {tasks
              .filter((t: Resource) => t.data.dueDate === iso(d))
              .map((t: Resource) => (
                <CalendarTask key={t.id} task={t} open={open} canEdit={canEdit} />
              ))}
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
}: {
  task: Resource;
  open: (task: Resource) => void;
  canEdit: boolean;
}) {
  const drag = useDrag(
    `calendar:${task.id}`,
    { type: "task", task, label: task.title },
    !canEdit,
  );
  return (
    <button
      ref={drag.ref}
      className={drag.dragging ? "dragging" : ""}
      onClick={() => open(task)}
      {...drag.handle}
    >
      {task.title}
    </button>
  );
}
