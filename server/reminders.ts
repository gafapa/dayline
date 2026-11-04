import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Connection, Database } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import { reminderSchema, reminderTargetKinds } from "../shared/reminders.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import { scheduleNotification } from "./notification-delivery.js";

export async function validateReminder(
  tx: Connection,
  proposed: Resource,
  previous: Resource | undefined,
  all: Resource[],
  userId: string,
) {
  if (proposed.kind !== "reminder") {
    if (proposed.data.reminder !== undefined)
      throw new HttpError(
        400,
        "La programación pertenece a un recordatorio personal.",
      );
    return;
  }
  if (
    proposed.created_by !== userId ||
    (proposed.data.ownerId && proposed.data.ownerId !== userId)
  )
    throw new HttpError(403, "El recordatorio pertenece a su autor.");
  if (previous && proposed.data.ownerId !== previous.data.ownerId)
    throw new HttpError(403, "Un recordatorio conserva su propietario.");
  const allowed = new Set([
    "ownerId",
    "targetId",
    "description",
    "archived",
    "reminder",
  ]);
  if (Object.keys(proposed.data).some((key) => !allowed.has(key)))
    throw new HttpError(
      400,
      "El recordatorio contiene campos que no le corresponden.",
    );
  const schedule = reminderSchema.parse(proposed.data.reminder);
  proposed.data.reminder = schedule;
  if (
    previous &&
    schedule.revisionId !== previous.data.reminder?.revisionId &&
    (
      await tx.query(
        "SELECT 1 FROM reminder_deliveries WHERE reminder_id=$1 AND revision_id=$2",
        [proposed.id, schedule.revisionId],
      )
    ).rows.length
  )
    throw new HttpError(
      409,
      "Esta programación ya fue procesada. Guarda una programación nueva para volver a avisar.",
    );
  if ((proposed.data.description || "").length > 2000)
    throw new HttpError(400, "El mensaje admite hasta 2000 caracteres.");
  if (
    proposed.data.targetId &&
    !all.some(
      (target) =>
        target.id === proposed.data.targetId &&
        reminderTargetKinds.has(target.kind),
    )
  )
    throw new HttpError(
      400,
      "Este elemento no admite recordatorios vinculados.",
    );
  if (
    previous &&
    schedule.revisionId === previous.data.reminder?.revisionId &&
    (proposed.title !== previous.title ||
      !isDeepStrictEqual(
        { ...proposed.data, ownerId: userId },
        { ...previous.data, ownerId: userId },
      ) ||
      !!proposed.deleted_at !== !!previous.deleted_at)
  )
    throw new HttpError(
      409,
      "Usa una programación nueva al cambiar, cancelar o restaurar el recordatorio.",
    );
  proposed.data.ownerId = userId;
}
export async function cancelPendingReminder(
  tx: Connection,
  resource: Resource,
) {
  if (resource.kind !== "reminder") return;
  await tx.query(
    "DELETE FROM notification_queue WHERE workspace_id=$1 AND payload->'sourceReminder'->>'id'=$2 AND ($3::boolean OR payload->'sourceReminder'->>'revisionId'<>$4)",
    [
      resource.workspace_id,
      resource.id,
      !!(
        resource.deleted_at ||
        resource.data.archived ||
        !resource.data.reminder?.enabled
      ),
      resource.data.reminder?.revisionId || "",
    ],
  );
}
export async function processReminders(
  db: Database,
  now: Date,
  workspaceId?: string,
) {
  const candidates = (
    await db.query<Resource>(
      `SELECT r.* FROM resources r WHERE kind='reminder' AND deleted_at IS NULL AND data->'reminder'->>'enabled'='true' AND coalesce(data->>'archived','false')<>'true' AND data->'reminder'->>'at'<=$1 AND ($2::uuid IS NULL OR workspace_id=$2) AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.reminder_id=r.id AND d.revision_id::text=r.data->'reminder'->>'revisionId') ORDER BY data->'reminder'->>'at',id LIMIT 50`,
      [now.toISOString(), workspaceId || null],
    )
  ).rows;
  const changed = new Set<string>();
  for (const candidate of candidates) {
    const didProcess = await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        candidate.workspace_id,
      ]);
      const reminder = (
        await tx.query<Resource>(
          "SELECT * FROM resources WHERE id=$1 FOR UPDATE",
          [candidate.id],
        )
      ).rows[0];
      const parsed = reminderSchema.safeParse(reminder?.data.reminder);
      if (
        !reminder ||
        !parsed.success ||
        reminder.deleted_at ||
        reminder.data.archived ||
        !parsed.data.enabled ||
        parsed.data.at > now.toISOString()
      )
        return false;
      const existing = (
        await tx.query(
          "SELECT revision_id FROM reminder_deliveries WHERE reminder_id=$1 AND revision_id=$2",
          [reminder.id, parsed.data.revisionId],
        )
      ).rows[0];
      if (existing?.revision_id === parsed.data.revisionId) return false;
      const all = (
        await tx.query<Resource>(
          "SELECT * FROM resources WHERE workspace_id=$1",
          [reminder.workspace_id],
        )
      ).rows;
      const member = (
        await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [reminder.workspace_id, reminder.created_by],
        )
      ).rows[0];
      let status: string = "unavailable",
        notificationId: string | null = null;
      if (
        member &&
        reminder.data.ownerId === reminder.created_by &&
        canRead(reminder, reminder.created_by, member.role, all)
      ) {
        notificationId = randomUUID();
        const notification = {
          id: notificationId,
          workspace_id: reminder.workspace_id,
          title: `Recordatorio: ${reminder.title}`.slice(0, 500),
          data: {
            assigneeId: reminder.created_by,
            targetId: reminder.id,
            description: reminder.data.description || reminder.title,
            read: false,
          },
          created_by: reminder.created_by,
        };
        status = await scheduleNotification(
          tx,
          notification,
          "reminder",
          now,
          "personal_reminder",
          undefined,
          { id: reminder.id, revisionId: parsed.data.revisionId },
        );
        if (status === "ready") {
          const delivered = (
            await tx.query<Resource>(
              "INSERT INTO resources(id,workspace_id,kind,title,data,created_by) VALUES($1,$2,'notification',$3,$4,$5) RETURNING *",
              [
                notification.id,
                notification.workspace_id,
                notification.title,
                JSON.stringify(notification.data),
                notification.created_by,
              ],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) VALUES($1,$2,$3,$4)",
            [
              delivered.id,
              delivered.version,
              JSON.stringify(delivered),
              reminder.created_by,
            ],
          );
          await tx.query(
            "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,'personal_reminder')",
            [reminder.workspace_id, delivered.id, reminder.created_by],
          );
          status = "delivered";
        }
        if (status === "suppressed") notificationId = null;
      }
      await tx.query(
        "INSERT INTO reminder_deliveries(reminder_id,revision_id,status,notification_id,processed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reminder_id,revision_id) DO NOTHING",
        [
          reminder.id,
          parsed.data.revisionId,
          status,
          notificationId,
          now.toISOString(),
        ],
      );
      return true;
    });
    if (didProcess) changed.add(candidate.workspace_id);
  }
  return changed;
}
export function registerReminderRoutes(
  app: FastifyInstance,
  db: Database,
  accessible: (
    req: FastifyRequest,
    workspaceId: string,
  ) => Promise<{
    user: User;
    role: Role;
    all: Resource[];
    visible: Resource[];
  }>,
) {
  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/reminders/status",
    async (req) => {
      const access = await accessible(req, req.params.workspaceId);
      const ids = access.visible
        .filter(
          (resource) =>
            resource.kind === "reminder" &&
            resource.created_by === access.user.id &&
            !resource.deleted_at,
        )
        .map((resource) => resource.id);
      if (!ids.length) return { deliveries: [] };
      const rows = (
        await db.query(
          `SELECT d.*,EXISTS(SELECT 1 FROM notification_queue q WHERE q.id=d.notification_id) AS queued,EXISTS(SELECT 1 FROM resources n WHERE n.id=d.notification_id AND n.deleted_at IS NULL) AS delivered FROM reminder_deliveries d JOIN resources r ON r.id=d.reminder_id AND r.data->'reminder'->>'revisionId'=d.revision_id::text WHERE d.reminder_id=ANY($1::uuid[])`,
          [ids],
        )
      ).rows;
      return {
        deliveries: rows.map((row) => ({
          reminderId: row.reminder_id,
          revisionId: row.revision_id,
          status:
            row.status === "queued"
              ? row.queued
                ? "queued"
                : row.delivered
                  ? "delivered"
                  : "cancelled"
              : row.status,
          processedAt: row.processed_at,
        })),
      };
    },
  );
}
