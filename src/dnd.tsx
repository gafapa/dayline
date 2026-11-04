import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Resource } from "../shared/model";

/** What is being dragged. */
export type DragItem =
  | { type: "task"; task: Resource; label: string }
  | { type: "structure"; resource: Resource; label: string }
  | { type: "favorite"; id: string; label: string };
/** A drop target: says what it accepts and what happens on drop. */
export type DropTarget = {
  accepts: (item: DragItem) => boolean;
  drop: (item: DragItem) => void | Promise<unknown>;
};

const collisions: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  return pointer.length ? pointer : rectIntersection(args);
};

/** One drag context for the whole app, so items can move between screens and the sidebar. */
export function DragProvider({
  children,
  onError,
}: {
  children: ReactNode;
  onError: (message: string) => void;
}) {
  const [active, setActive] = useState<DragItem | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      onDragStart={(event: DragStartEvent) =>
        setActive((event.active.data.current as DragItem) || null)
      }
      onDragCancel={() => setActive(null)}
      onDragEnd={(event: DragEndEvent) => {
        setActive(null);
        const item = event.active.data.current as DragItem | undefined,
          target = event.over?.data.current as DropTarget | undefined;
        if (!item || !target?.accepts(item)) return;
        Promise.resolve(target.drop(item)).catch((e) =>
          onError((e as Error).message),
        );
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Pulsa espacio para coger el elemento, muévelo con las flechas y pulsa espacio de nuevo para soltarlo. Escape cancela.",
        },
        announcements: {
          onDragStart: ({ active }) =>
            `Has cogido ${(active.data.current as DragItem)?.label || "el elemento"}.`,
          onDragOver: ({ over }) =>
            over ? "Encima de un destino válido." : "Fuera de los destinos.",
          onDragEnd: ({ over }) =>
            over ? "Elemento soltado." : "Movimiento cancelado.",
          onDragCancel: () => "Movimiento cancelado.",
        },
      }}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {active ? <div className="drag-overlay">{active.label}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Makes an element draggable; spread `handle` on the grip (or the element itself). */
export function useDrag(id: string, item: DragItem, disabled = false) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: item,
    disabled,
  });
  return {
    ref: setNodeRef,
    handle: disabled ? {} : { ...attributes, ...listeners },
    dragging: isDragging,
  };
}

/** Makes an element a drop target. `over` is true while an accepted item hovers it. */
export function useDrop(id: string, target: DropTarget, disabled = false) {
  const { setNodeRef, isOver, active } = useDroppable({
    id,
    data: target,
    disabled,
  });
  const item = active?.data.current as DragItem | undefined;
  return {
    ref: setNodeRef,
    over: isOver && !!item && target.accepts(item),
    armed: !!item && target.accepts(item),
  };
}

/** A position strictly between two neighbours' `order` values. */
export function orderBetween(before?: number | null, after?: number | null) {
  if (before == null && after == null) return 1000;
  if (before == null) return (after as number) - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

/**
 * New `order` values to place `moving` before `beforeId` (or at the end) in `list`.
 * Returns only the tasks whose order must change; renumbers when neighbours lack an order.
 */
export function placeInOrder(
  list: Resource[],
  moving: Resource,
  beforeId: string | null,
): Map<string, number> {
  const rest = list.filter((t) => t.id !== moving.id);
  let index = beforeId ? rest.findIndex((t) => t.id === beforeId) : rest.length;
  if (index < 0) index = rest.length;
  const prev = rest[index - 1],
    next = rest[index];
  const changes = new Map<string, number>();
  const numeric = (t?: Resource) => t === undefined || typeof t.data.order === "number";
  if (numeric(prev) && numeric(next)) {
    const value = orderBetween(prev?.data.order, next?.data.order);
    if (value !== moving.data.order && (!prev || value > prev.data.order) && (!next || value < next.data.order)) {
      changes.set(moving.id, value);
      return changes;
    }
  }
  const sequence = [...rest.slice(0, index), moving, ...rest.slice(index)];
  sequence.forEach((task, i) => {
    const value = (i + 1) * 1000;
    if (task.data.order !== value) changes.set(task.id, value);
  });
  return changes;
}
