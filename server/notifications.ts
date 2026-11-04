import { randomUUID } from "node:crypto";
import type { Connection } from "./database.js";
import type { Resource, Role } from "../shared/model.js";
import { canRead } from "./permissions.js";
import { scheduleNotification } from "./notification-delivery.js";
import type { NotificationCategory } from "../shared/notifications.js";

export async function notifyChange(
  tx: Connection,
  resource: Resource,
  previous: Resource | undefined,
  all: Resource[],
  actorId: string,
) {
  if (
    resource.deleted_at ||
    ["notification", "view", "time_entry", "reminder"].includes(resource.kind)
  )
    return;
  const recipients = new Map<
    string,
    { title: string; category: NotificationCategory }[]
  >();
  const recipient = (
    id: string,
    title: string,
    category: NotificationCategory,
  ) => recipients.set(id, [...(recipients.get(id) || []), { title, category }]);
  if (
    resource.data.assigneeId &&
    resource.data.assigneeId !== previous?.data.assigneeId
  )
    recipient(
      resource.data.assigneeId,
      resource.kind === "task"
        ? "Te han asignado una tarea"
        : "Te han asignado un elemento de planificación",
      "assignment",
    );
  for (const id of resource.data.reviewers || [])
    if (!(previous?.data.reviewers || []).includes(id))
      recipient(id, "Tienes una solicitud de revisión", "review");
  for (const id of resource.data.followers || [])
    if (previous)
      recipient(id, "Novedades en un elemento que sigues", "following");
  const members = (
    await tx.query(
      "SELECT m.user_id,m.role,u.email FROM memberships m JOIN app_users u ON u.id=m.user_id WHERE m.workspace_id=$1",
      [resource.workspace_id],
    )
  ).rows;
  const target =
    resource.kind === "comment"
      ? all.find((r) => r.id === resource.data.targetId)
      : resource;
  if (resource.kind === "comment" && target) {
    for (const id of [
      target.created_by,
      target.data.assigneeId,
      ...(target.data.followers || []),
    ])
      if (id) recipient(id, "Nuevo comentario", "comment");
    const text = String(resource.data.description || "").toLowerCase();
    for (const member of members)
      if (text.includes("@" + member.email.toLowerCase()))
        recipient(member.user_id, "Te han mencionado", "mention");
  }
  const current = [...all.filter((r) => r.id !== resource.id), resource];
  for (const [id, reasons] of recipients) {
    if (id === actorId) continue;
    const member = members.find((m) => m.user_id === id);
    if (
      !member ||
      !target ||
      !canRead(target, id, member.role as Role, current)
    )
      continue;
    const notificationId = randomUUID();
    const data = {
      assigneeId: id,
      targetId: target.id,
      description: target.title,
      read: false,
      ...(target.data.projectId ? { projectId: target.data.projectId } : {}),
    };
    for (const { title, category } of [...reasons].reverse()) {
      const status = await scheduleNotification(
        tx,
        {
          id: notificationId,
          workspace_id: resource.workspace_id,
          title,
          data,
          created_by: actorId,
        },
        category,
      );
      if (status === "suppressed") continue;
      if (status === "ready")
        await tx.query(
          "INSERT INTO resources(id,workspace_id,kind,title,data,created_by) VALUES($1,$2,'notification',$3,$4,$5)",
          [
            notificationId,
            resource.workspace_id,
            title,
            JSON.stringify(data),
            actorId,
          ],
        );
      break;
    }
  }
}
