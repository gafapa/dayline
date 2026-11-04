import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Connection, Database } from "./database.js";
import type { User, Role, Resource } from "../shared/model.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
const maximumSize = 5 * 1024 * 1024;
export function detectFileType(bytes: Buffer, requested: string) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
    return "image/gif";
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (requested === "text/plain" && !bytes.includes(0)) return "text/plain";
  return "application/octet-stream";
}
export function registerAttachments(
  app: FastifyInstance,
  db: Database,
  options: {
    userFor: (req: FastifyRequest) => Promise<User>;
    membership: (
      tx: Connection,
      workspaceId: string,
      userId: string,
      write?: boolean,
    ) => Promise<Role>;
  },
) {
  async function authorize(
    tx: Connection,
    workspaceId: string,
    targetId: string,
    user: User,
    write = false,
  ) {
    const role = await options.membership(
      tx,
      z.string().uuid().parse(workspaceId),
      user.id,
      write,
    );
    const all = (
      await tx.query<Resource>(
        "SELECT * FROM resources WHERE workspace_id=$1",
        [workspaceId],
      )
    ).rows;
    const target = all.find((r) => r.id === targetId && !r.deleted_at);
    if (!target || !canRead(target, user.id, role, all))
      throw new HttpError(404, "No se encuentra el elemento.");
  }
  app.get<{ Params: { workspaceId: string; resourceId: string } }>(
    "/api/workspaces/:workspaceId/resources/:resourceId/attachments",
    async (req) => {
      const user = await options.userFor(req);
      await authorize(db, req.params.workspaceId, req.params.resourceId, user);
      return {
        attachments: (
          await db.query(
            "SELECT id,name,mime,size,created_at,created_by FROM attachments WHERE target_id=$1 AND deleted_at IS NULL ORDER BY created_at",
            [req.params.resourceId],
          )
        ).rows,
      };
    },
  );
  app.post<{ Params: { workspaceId: string; resourceId: string } }>(
    "/api/workspaces/:workspaceId/resources/:resourceId/attachments",
    { bodyLimit: Math.ceil(maximumSize * 1.4) + 4096 },
    async (req) => {
      const user = await options.userFor(req);
      const input = z
        .object({
          name: z.string().trim().min(1).max(250),
          mime: z.string().max(150),
          base64: z
            .string()
            .min(4)
            .max(Math.ceil(maximumSize * 1.4)),
        })
        .parse(req.body);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64))
        throw new HttpError(400, "El archivo no es válido.");
      const bytes = Buffer.from(input.base64, "base64");
      if (!bytes.length || bytes.length > maximumSize)
        throw new HttpError(413, "Cada archivo puede ocupar hasta 5 MiB.");
      const mime = detectFileType(bytes, input.mime),
        id = randomUUID();
      return db.transaction(async (tx) => {
        await authorize(
          tx,
          req.params.workspaceId,
          req.params.resourceId,
          user,
          true,
        );
        const used = Number(
          (
            await tx.query(
              "SELECT coalesce(sum(size),0) AS total FROM attachments WHERE workspace_id=$1 AND deleted_at IS NULL",
              [req.params.workspaceId],
            )
          ).rows[0].total,
        );
        if (used + bytes.length > 100 * 1024 * 1024)
          throw new HttpError(
            413,
            "El espacio ha alcanzado el límite de 100 MiB de adjuntos.",
          );
        await tx.query(
          "INSERT INTO attachments(id,workspace_id,target_id,name,mime,size,body,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id,
            req.params.workspaceId,
            req.params.resourceId,
            input.name,
            mime,
            bytes.length,
            bytes,
            user.id,
          ],
        );
        await tx.query(
          "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,'attachment_added')",
          [req.params.workspaceId, req.params.resourceId, user.id],
        );
        return {
          attachment: {
            id,
            name: input.name,
            mime,
            size: bytes.length,
            url: `/api/workspaces/${req.params.workspaceId}/attachments/${id}`,
          },
        };
      });
    },
  );
  app.get<{
    Params: { workspaceId: string; attachmentId: string };
    Querystring: { download?: string };
  }>(
    "/api/workspaces/:workspaceId/attachments/:attachmentId",
    async (req, reply) => {
      const user = await options.userFor(req);
      const file = (
        await db.query(
          "SELECT * FROM attachments WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
          [
            z.string().uuid().parse(req.params.attachmentId),
            z.string().uuid().parse(req.params.workspaceId),
          ],
        )
      ).rows[0];
      if (!file) throw new HttpError(404, "No se encuentra el archivo.");
      await authorize(db, req.params.workspaceId, file.target_id, user);
      const inline = file.mime.startsWith("image/") && !req.query.download;
      reply
        .type(file.mime)
        .header(
          "Content-Disposition",
          `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
        )
        .header("X-Content-Type-Options", "nosniff");
      return reply.send(Buffer.from(file.body));
    },
  );
  app.delete<{ Params: { workspaceId: string; attachmentId: string } }>(
    "/api/workspaces/:workspaceId/attachments/:attachmentId",
    async (req) => {
      const user = await options.userFor(req);
      return db.transaction(async (tx) => {
        const file = (
          await tx.query(
            "SELECT target_id FROM attachments WHERE id=$1 AND workspace_id=$2",
            [
              z.string().uuid().parse(req.params.attachmentId),
              req.params.workspaceId,
            ],
          )
        ).rows[0];
        if (!file) throw new HttpError(404, "No se encuentra el archivo.");
        await authorize(tx, req.params.workspaceId, file.target_id, user, true);
        await tx.query("UPDATE attachments SET deleted_at=now() WHERE id=$1", [
          req.params.attachmentId,
        ]);
        return { ok: true };
      });
    },
  );
}
