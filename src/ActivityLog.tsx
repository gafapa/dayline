import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { api } from "./api";
import { type Resource } from "../shared/model";
import { Empty } from "./ui-common";

export function Activity({ workspaceId, resources, open }: any) {
  const [activity, setActivity] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    api(`/workspaces/${workspaceId}/activity`)
      .then((r) => setActivity(r.activity))
      .catch((e) => setError(e.message));
  }, [workspaceId]);
  const labels: any = {
    created: "creó",
    updated: "actualizó",
    deleted: "eliminó",
    delivery_confirmed: "confirmó la entrega",
    sprint_closed: "cerró el sprint",
    sprint_rollover: "trasladó la tarea",
    sprint_planned: "actualizó la planificación",
    sprint_started: "inició el sprint",
    sprint_scope_changed: "cambió el alcance de la tarea",
    sprint_review_updated: "actualizó la revisión y retrospectiva",
    poker_started: "inició una ronda de estimación",
    poker_estimate_applied: "aplicó la estimación acordada",
    automation_updated: "actualizó mediante una regla",
    automation_notification: "creó una notificación automática",
    personal_reminder: "entregó un recordatorio personal",
    recurrence_created: "creó la siguiente tarea recurrente",
    automation_retry: "reintentó una ejecución",
    ai_generated: "generó una propuesta con IA",
  };
  return (
    <div className="activity-feed">
      {error && <p role="alert">{error}</p>}
      {activity.map((event) => (
        <article key={event.sequence}>
          <span className="avatar small">
            {event.user_name?.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <p>
              <strong>{event.user_name}</strong>{" "}
              {labels[event.action] || event.action}
              {event.resource_id && (
                <button
                  className="text-button"
                  onClick={() => {
                    const r = resources.find(
                      (r: Resource) => r.id === event.resource_id,
                    );
                    if (r) open(r);
                  }}
                >
                  {resources.find((r: Resource) => r.id === event.resource_id)
                    ?.title || "Elemento"}
                </button>
              )}
            </p>
            <time>{new Date(event.created_at).toLocaleString("es")}</time>
          </div>
        </article>
      ))}
      {!activity.length && !error && (
        <Empty
          icon={History}
          title="El historial empieza aquí"
          description="Los cambios del equipo quedarán registrados en este espacio."
        />
      )}
    </div>
  );
}
