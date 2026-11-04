import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { digest, hashPassword, token } from "./security.js";
import { HttpError } from "./errors.js";
import type { Connection, Database } from "./database.js";
import type { User } from "../shared/model.js";

const uuid = z.string().uuid();
const RESET_HOURS = 24;

/** Platform-wide account administration, separate from workspace roles. */
export function registerPlatform(
  app: FastifyInstance,
  db: Database,
  options: {
    origin: string;
    platformAdminFor: (req: FastifyRequest) => Promise<User>;
  },
) {
  const audit = (
    tx: Connection,
    actorId: string,
    targetId: string | null,
    action: string,
    details: Record<string, unknown> = {},
  ) =>
    tx.query(
      "INSERT INTO platform_audit(actor_id,target_id,action,details) VALUES($1,$2,$3,$4)",
      [actorId, targetId, action, JSON.stringify(details)],
    );
  const target = async (tx: Connection, id: string) => {
    const row = (
      await tx.query(
        "SELECT id,email,name,platform_admin,suspended_at FROM app_users WHERE id=$1 FOR UPDATE",
        [uuid.parse(id)],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "La cuenta no existe.");
    return row;
  };
  const activeAdmins = async (tx: Connection) =>
    (
      await tx.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM app_users WHERE platform_admin AND suspended_at IS NULL",
      )
    ).rows[0].count;
  /** Runs one audited action against another account inside a transaction. */
  const act = (
    path: string,
    action: string,
    run: (
      tx: Connection,
      account: any,
      actor: User,
      body: any,
    ) => Promise<Record<string, unknown> | void>,
  ) =>
    app.post<{ Params: { userId: string } }>(
      `/api/platform/users/:userId/${path}`,
      { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } },
      async (req) => {
        const actor = await options.platformAdminFor(req);
        return db.transaction(async (tx) => {
          await tx.query("LOCK TABLE platform_audit IN SHARE ROW EXCLUSIVE MODE");
          const account = await target(tx, req.params.userId);
          const result = (await run(tx, account, actor, req.body || {})) || {};
          const { auditDetails, ...response } = result as any;
          await audit(tx, actor.id, account.id, action, auditDetails || {});
          return { ok: true, ...response };
        });
      },
    );

  app.get("/api/platform/users", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await options.platformAdminFor(req);
    const query = z
      .object({ q: z.string().trim().max(200).optional() })
      .parse(req.query);
    const term = query.q ? `%${query.q.toLowerCase()}%` : null;
    const users = (
      await db.query(
        `SELECT u.id, u.email, u.name, u.created_at, u.last_login_at, u.suspended_at, u.platform_admin,
           (u.mfa_secret IS NOT NULL) AS mfa_enabled,
           (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.expires_at>now()) AS session_count,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'role',m.role) ORDER BY w.name)
             FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=u.id), '[]') AS workspaces
         FROM app_users u
         WHERE $1::text IS NULL OR lower(u.email) LIKE $1 OR lower(u.name) LIKE $1
         ORDER BY u.created_at LIMIT 500`,
        [term],
      )
    ).rows;
    return { users };
  });

  app.get("/api/platform/audit", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await options.platformAdminFor(req);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return {
      entries: (
        await db.query(
          `SELECT a.id, a.action, a.details, a.created_at,
             actor.email AS actor_email, target.email AS target_email
           FROM platform_audit a JOIN app_users actor ON actor.id=a.actor_id
           LEFT JOIN app_users target ON target.id=a.target_id
           ORDER BY a.id DESC LIMIT $1`,
          [query.limit],
        )
      ).rows,
    };
  });

  act("suspend", "suspend", async (tx, account, actor) => {
    if (account.id === actor.id)
      throw new HttpError(409, "No puedes suspender tu propia cuenta.");
    if (account.suspended_at)
      throw new HttpError(409, "La cuenta ya está suspendida.");
    if (account.platform_admin && (await activeAdmins(tx)) <= 1)
      throw new HttpError(409, "Debe quedar al menos una administración de la plataforma activa.");
    await tx.query("UPDATE app_users SET suspended_at=now() WHERE id=$1", [account.id]);
    const closed = await tx.query("DELETE FROM sessions WHERE user_id=$1 RETURNING token_hash", [account.id]);
    await tx.query("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [account.id]);
    return { sessionsClosed: closed.rows.length, auditDetails: { sessionsClosed: closed.rows.length } };
  });

  act("reactivate", "reactivate", async (tx, account) => {
    if (!account.suspended_at)
      throw new HttpError(409, "La cuenta no está suspendida.");
    await tx.query("UPDATE app_users SET suspended_at=NULL WHERE id=$1", [account.id]);
  });

  act("sessions/revoke", "revoke_sessions", async (tx, account) => {
    const closed = await tx.query("DELETE FROM sessions WHERE user_id=$1 RETURNING token_hash", [account.id]);
    return { sessionsClosed: closed.rows.length, auditDetails: { sessionsClosed: closed.rows.length } };
  });

  act("mfa/reset", "reset_mfa", async (tx, account) => {
    await tx.query(
      "UPDATE app_users SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_pending_expires_at=NULL, recovery_hashes='[]' WHERE id=$1",
      [account.id],
    );
    const closed = await tx.query("DELETE FROM sessions WHERE user_id=$1 RETURNING token_hash", [account.id]);
    return { sessionsClosed: closed.rows.length, auditDetails: { sessionsClosed: closed.rows.length } };
  });

  act("password-reset", "create_password_reset", async (tx, account, actor) => {
    if (account.suspended_at)
      throw new HttpError(409, "Reactiva la cuenta antes de crear un enlace de restablecimiento.");
    // Only the newest link stays valid.
    await tx.query("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [account.id]);
    const value = token();
    await tx.query(
      `INSERT INTO password_resets(token_hash,user_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '${RESET_HOURS} hours')`,
      [digest(value), account.id, actor.id],
    );
    return {
      url: `${options.origin}/?reset=${value}`,
      expiresInHours: RESET_HOURS,
      auditDetails: { expiresInHours: RESET_HOURS },
    };
  });

  act("platform-admin", "set_platform_admin", async (tx, account, actor, body) => {
    const input = z.object({ platformAdmin: z.boolean() }).strict().parse(body);
    if (input.platformAdmin === !!account.platform_admin)
      return { auditDetails: { platformAdmin: input.platformAdmin, unchanged: true } };
    if (!input.platformAdmin) {
      if (account.id === actor.id)
        throw new HttpError(409, "Pide a otra persona administradora que retire tu acceso.");
      if (!account.suspended_at && (await activeAdmins(tx)) <= 1)
        throw new HttpError(409, "Debe quedar al menos una administración de la plataforma activa.");
    }
    await tx.query("UPDATE app_users SET platform_admin=$1 WHERE id=$2", [input.platformAdmin, account.id]);
    return { auditDetails: { platformAdmin: input.platformAdmin } };
  });

  app.post(
    "/api/account/reset",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (req, reply: FastifyReply) => {
      const input = z
        .object({
          token: z.string().min(20).max(100),
          newPassword: z.string().min(8).max(200),
        })
        .strict()
        .parse(req.body);
      const hash = await hashPassword(input.newPassword);
      await db.transaction(async (tx) => {
        const reset = (
          await tx.query(
            `SELECT r.user_id FROM password_resets r JOIN app_users u ON u.id=r.user_id
             WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at>now() AND u.suspended_at IS NULL FOR UPDATE OF r`,
            [digest(input.token)],
          )
        ).rows[0];
        if (!reset)
          throw new HttpError(400, "El enlace no es válido o ha caducado. Pide uno nuevo a la administración.");
        await tx.query("UPDATE password_resets SET used_at=now() WHERE token_hash=$1", [digest(input.token)]);
        await tx.query("UPDATE app_users SET password_hash=$1 WHERE id=$2", [hash, reset.user_id]);
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [reset.user_id]);
        await audit(tx, reset.user_id, reset.user_id, "complete_password_reset");
      });
      reply.clearCookie("kelvin_session", { path: "/" });
      return { ok: true };
    },
  );
}
