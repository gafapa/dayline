import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database, Connection } from "./database.js";
import type { Resource, User } from "../shared/model.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import { ruleMatches, validDay, zonedClock } from "../shared/automation.js";
import {
  notificationSettingsSchema,
  storedNotificationSettings,
  notificationAllowed,
  nextNotificationTime,
  type NotificationCategory,
} from "../shared/notifications.js";

type Notification = Pick<
  Resource,
  "id" | "workspace_id" | "title" | "data" | "created_by"
> & {
  sourceRule?: { id: string; version: number };
  sourceReminder?: { id: string; revisionId: string };
};
async function preferences(tx: Connection, userId: string) {
  return (
    (
      await tx.query("SELECT data FROM user_preferences WHERE user_id=$1", [
        userId,
      ])
    ).rows[0]?.data || {}
  );
}
export async function scheduleNotification(
  tx: Connection,
  resource: Notification,
  category: NotificationCategory,
  now = new Date(),
  action?: string,
  sourceRule?: { id: string; version: number },
  sourceReminder?: { id: string; revisionId: string },
) {
  const settings = storedNotificationSettings(
    await preferences(tx, resource.data.assigneeId),
  );
  if (!notificationAllowed(settings, category)) return "suppressed" as const;
  const delivery = nextNotificationTime(settings, now);
  if (delivery.getTime() <= now.getTime()) return "ready" as const;
  await tx.query(
    "INSERT INTO notification_queue(id,workspace_id,recipient_id,category,deliver_at,payload,action) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING",
    [
      resource.id,
      resource.workspace_id,
      resource.data.assigneeId,
      category,
      delivery.toISOString(),
      JSON.stringify({
        ...resource,
        ...(sourceRule ? { sourceRule } : {}),
        ...(sourceReminder ? { sourceReminder } : {}),
      }),
      action || null,
    ],
  );
  return "queued" as const;
}
export async function deliverNotifications(
  db: Database,
  now: Date,
  workspaceId?: string,
) {
  const candidates = (
    await db.query(
      "SELECT id,workspace_id FROM notification_queue WHERE deliver_at<=$1 AND ($2::uuid IS NULL OR workspace_id=$2) ORDER BY deliver_at,id LIMIT 50",
      [now.toISOString(), workspaceId || null],
    )
  ).rows;
  const changed = new Set<string>();
  for (const candidate of candidates) {
    const delivered = await db.transaction(async (tx) => {
      // Match metadata writer lock order before acquiring a delivery row lock.
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        candidate.workspace_id,
      ]);
      const queued = (
        await tx.query(
          "SELECT * FROM notification_queue WHERE id=$1 FOR UPDATE",
          [candidate.id],
        )
      ).rows[0];
      if (!queued || new Date(queued.deliver_at).getTime() > now.getTime())
        return false;
      const resource = queued.payload as Notification;
      const settings = storedNotificationSettings(
        await preferences(tx, queued.recipient_id),
      );
      const member = (
        await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [queued.workspace_id, queued.recipient_id],
        )
      ).rows[0];
      const all = member
        ? (
            await tx.query<Resource>(
              "SELECT * FROM resources WHERE workspace_id=$1",
              [queued.workspace_id],
            )
          ).rows
        : [];
      const rule =
        resource.sourceRule &&
        all.find((item) => item.id === resource.sourceRule!.id);
      const actor =
        rule &&
        (
          await tx.query(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [queued.workspace_id, resource.created_by],
          )
        ).rows[0];
      const ruleAvailable =
        !resource.sourceRule ||
        (rule &&
          actor &&
          ["admin", "member"].includes(actor.role) &&
          rule.kind === "automation" &&
          !rule.deleted_at &&
          rule.data.enabled &&
          !rule.data.archived &&
          rule.version === resource.sourceRule.version &&
          canRead(rule, resource.created_by, actor.role, all));
      const sourceReminder =
        resource.sourceReminder &&
        all.find((item) => item.id === resource.sourceReminder!.id);
      const reminderAvailable =
        !resource.sourceReminder ||
        (sourceReminder &&
          sourceReminder.kind === "reminder" &&
          sourceReminder.created_by === queued.recipient_id &&
          !sourceReminder.deleted_at &&
          !sourceReminder.data.archived &&
          sourceReminder.data.reminder?.enabled &&
          sourceReminder.data.reminder.revisionId ===
            resource.sourceReminder.revisionId);
      const visible =
        reminderAvailable &&
        ruleAvailable &&
        member &&
        notificationAllowed(settings, queued.category) &&
        [resource.data.targetId, resource.data.projectId]
          .filter(Boolean)
          .every((id) => {
            const target = all.find((item) => item.id === id);
            return (
              target &&
              !target.deleted_at &&
              canRead(target, queued.recipient_id, member.role, all)
            );
          });
      if (!visible) {
        await tx.query("DELETE FROM notification_queue WHERE id=$1", [
          queued.id,
        ]);
        return false;
      }
      const next = nextNotificationTime(settings, now);
      if (next.getTime() > now.getTime()) {
        await tx.query(
          "UPDATE notification_queue SET deliver_at=$2 WHERE id=$1",
          [queued.id, next.toISOString()],
        );
        return false;
      }
      if (queued.category === "summary" && rule && actor) {
        const tasks = all.filter(
          (task) =>
            ruleMatches(rule, task) &&
            canRead(task, resource.created_by, actor.role, all) &&
            canRead(task, queued.recipient_id, member.role, all),
        );
        const today = zonedClock(now, rule.data.timeZone || "UTC").day;
        resource.data.description = `${tasks.filter((task) => task.data.status === "done").length} completadas · ${tasks.filter((task) => !["done", "cancelled"].includes(task.data.status)).length} pendientes · ${tasks.filter((task) => validDay(task.data.dueDate) && task.data.dueDate < today && !["done", "cancelled"].includes(task.data.status)).length} vencidas.`;
      }
      const result = (
        await tx.query<Resource>(
          "INSERT INTO resources(id,workspace_id,kind,title,data,created_by) VALUES($1,$2,'notification',$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING *",
          [
            resource.id,
            resource.workspace_id,
            resource.title,
            JSON.stringify(resource.data),
            resource.created_by,
          ],
        )
      ).rows[0];
      if (result && queued.action) {
        await tx.query(
          "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) VALUES($1,$2,$3,$4)",
          [
            result.id,
            result.version,
            JSON.stringify(result),
            result.created_by,
          ],
        );
        await tx.query(
          "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,$4)",
          [result.workspace_id, result.id, result.created_by, queued.action],
        );
      }
      await tx.query("DELETE FROM notification_queue WHERE id=$1", [queued.id]);
      return !!result;
    });
    if (delivered) changed.add(candidate.workspace_id);
  }
  return changed;
}
export function registerNotificationSettings(
  app: FastifyInstance,
  db: Database,
  userFor: (req: FastifyRequest) => Promise<User>,
) {
  app.get("/api/notification-settings", async (req) => {
    const user = await userFor(req),
      data = await preferences(db, user.id);
    const pending = (
      await db.query(
        "SELECT count(*)::int AS count FROM notification_queue WHERE recipient_id=$1",
        [user.id],
      )
    ).rows[0].count;
    return {
      settings: storedNotificationSettings(data),
      version: data.notificationSettingsVersion || 0,
      pending,
    };
  });
  app.put("/api/notification-settings", async (req) => {
    const user = await userFor(req);
    const input = z
      .object({
        settings: notificationSettingsSchema,
        expectedVersion: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query("SELECT id FROM app_users WHERE id=$1 FOR NO KEY UPDATE", [
        user.id,
      ]);
      const data = await preferences(tx, user.id),
        version = data.notificationSettingsVersion || 0;
      const settings = storedNotificationSettings(data);
      if (input.expectedVersion !== version) {
        if (
          input.expectedVersion + 1 === version &&
          isDeepStrictEqual(settings, input.settings)
        )
          return { settings, version, replay: true };
        throw new HttpError(
          409,
          "Las preferencias cambiaron en otra sesión. Tu borrador se conserva; carga las preferencias del servidor antes de volver a editarlas.",
        );
      }
      const patch = {
        notificationSettings: input.settings,
        notificationSettingsVersion: version + 1,
      };
      await tx.query(
        "INSERT INTO user_preferences VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=user_preferences.data || EXCLUDED.data",
        [user.id, JSON.stringify(patch)],
      );
      await tx.query(
        "UPDATE notification_queue SET deliver_at=$2 WHERE recipient_id=$1",
        [user.id, new Date().toISOString()],
      );
      return { settings: input.settings, version: version + 1 };
    });
  });
}
