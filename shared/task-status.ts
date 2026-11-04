export const taskStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
] as const;
export const statusLabels: Record<string, string> = {
  backlog: "Backlog",
  todo: "Por hacer",
  in_progress: "En curso",
  review: "En revisión",
  done: "Completada",
  cancelled: "Cancelada",
  planned: "Planificado",
  active: "Activo",
  completed: "Cerrado",
  paused: "En pausa",
};
