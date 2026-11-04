import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Connection } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import { mutationSchema } from "../shared/model.js";
import { isDelivery, deliveryReceiptSchema } from "../shared/delivery.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import { applyMutation, resources } from "./mutations.js";
import { deliveryReadiness } from "./delivery-validation.js";
const id = z.string().uuid();
export function registerDeliveryRoutes(
  app: FastifyInstance,
  db: Database,
  userFor: (request: FastifyRequest) => Promise<User>,
) {
  type Params = { workspaceId: string; resourceId: string };
  async function context(
    tx: Connection,
    params: Params,
    user: User,
    write = false,
  ) {
    id.parse(params.workspaceId);
    id.parse(params.resourceId);
    if (write)
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        params.workspaceId,
      ]);
    const member = (
      await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2" +
          (write ? " FOR UPDATE" : ""),
        [params.workspaceId, user.id],
      )
    ).rows[0];
    if (!member || (write && member.role === "viewer"))
      throw new HttpError(403, "Se requiere acceso de edición al proyecto.");
    const all = await resources(tx, params.workspaceId),
      resource = all.find(
        (r) => r.id === params.resourceId && isDelivery(r) && !r.deleted_at,
      );
    if (!resource || !canRead(resource, user.id, member.role, all))
      throw new HttpError(
        404,
        "No se encuentra este registro de planificación.",
      );
    return { all, resource, role: member.role as Role };
  }
  app.get<{ Params: Params }>(
    "/api/workspaces/:workspaceId/planning/:resourceId/readiness",
    async (req) => {
      const user = await userFor(req);
      return db.transaction(async (tx) => {
        const { all, resource, role } = await context(tx, req.params, user);
        return deliveryReadiness(resource, all, user.id, role);
      });
    },
  );
  app.post<{ Params: Params }>(
    "/api/workspaces/:workspaceId/planning/:resourceId/confirm",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: id,
            expectedVersion: z.number().int().positive(),
            expectedReferences: z
              .array(
                z.object({ id, version: z.number().int().positive() }).strict(),
              )
              .max(500),
            note: z.string().max(100000).default(""),
          })
          .strict()
          .parse(req.body);
      return db.transaction(async (tx) => {
        const { all, resource, role } = await context(
          tx,
          req.params,
          user,
          true,
        );
        const previous = (
          await tx.query("SELECT * FROM operations WHERE id=$1", [
            input.operationId,
          ])
        ).rows[0];
        if (previous) {
          if (
            previous.user_id !== user.id ||
            previous.workspace_id !== req.params.workspaceId ||
            previous.response.command !== "delivery_confirm" ||
            previous.response.resourceId !== resource.id
          )
            throw new HttpError(
              409,
              "Identificador de operación ya utilizado.",
            );
          return previous.response;
        }
        if (resource.version !== input.expectedVersion)
          throw new HttpError(
            409,
            "El registro cambió. Actualiza las comprobaciones antes de confirmar.",
          );
        const readiness = deliveryReadiness(resource, all, user.id, role);
        const expected = new Map(
          input.expectedReferences.map((r) => [r.id, r.version]),
        );
        if (
          expected.size !== input.expectedReferences.length ||
          expected.size !== readiness.references.length ||
          readiness.references.some((r) => expected.get(r.id) !== r.version)
        )
          throw new HttpError(
            409,
            "El alcance cambió. Revisa las versiones actuales antes de confirmar.",
          );
        if (!readiness.ready)
          throw new HttpError(409, "Hay condiciones de entrega pendientes.", {
            issues: readiness.issues,
          });
        const status =
          resource.kind === "milestone"
            ? "achieved"
            : resource.kind === "release"
              ? "released"
              : "accepted";
        const scopes = readiness.references.map((r) => ({
          id: r.id,
          kind: r.kind,
          createdBy: r.created_by,
          ...Object.fromEntries(
            [
              "projectId",
              "parentId",
              "ownerId",
              "targetId",
              "assigneeId",
              "private",
              "members",
            ]
              .filter(
                (key) => r.data[key] !== undefined && r.data[key] !== null,
              )
              .map((key) => [key, r.data[key]]),
          ),
        }));
        const receipt = deliveryReceiptSchema.parse({
          at: new Date().toISOString(),
          actorId: user.id,
          version: resource.version + 1,
          finalStatus: status,
          scopes,
          items: readiness.references.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            version: r.version,
            status: r.data.status || "",
            ...(r.data.estimate !== undefined
              ? { estimate: r.data.estimate }
              : {}),
            ...(r.data.dueDate ? { dueDate: r.data.dueDate } : {}),
            ...(r.kind === "risk" && r.data.delivery?.type === "risk"
              ? {
                  riskScore:
                    r.data.delivery.probability * r.data.delivery.impact,
                  summary: [
                    r.data.delivery.dispositionReason,
                    r.data.delivery.mitigation,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                }
              : {}),
          })),
          checklist: resource.data.checklist || [],
          note: input.note,
        });
        if (Buffer.byteLength(JSON.stringify(receipt)) > 900 * 1024)
          throw new HttpError(
            413,
            "La confirmación supera el límite de 900 KiB. Reduce el alcance o los textos del registro.",
          );
        const result = await applyMutation(
          tx,
          req.params.workspaceId,
          user,
          role,
          mutationSchema.parse({
            operationId: randomUUID(),
            id: resource.id,
            kind: resource.kind,
            title: resource.title,
            data: { ...resource.data, status, deliveryReceipt: receipt },
            expectedVersion: resource.version,
          }),
          { skipOperation: true, deliveryFinalization: true },
        );
        const oldId =
          resource.kind === "decision"
            ? resource.data.delivery.supersedesId
            : null;
        if (oldId) {
          const old = all.find((r) => r.id === oldId)!;
          await applyMutation(
            tx,
            req.params.workspaceId,
            user,
            role,
            mutationSchema.parse({
              operationId: randomUUID(),
              id: old.id,
              kind: old.kind,
              title: old.title,
              expectedVersion: old.version,
              data: {
                ...old.data,
                status: "superseded",
                delivery: { ...old.data.delivery, supersededById: resource.id },
              },
            }),
            { skipOperation: true, deliveryFinalization: true },
          );
        }
        await tx.query(
          "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,'delivery_confirmed')",
          [req.params.workspaceId, resource.id, user.id],
        );
        const response = {
          command: "delivery_confirm",
          resourceId: resource.id,
          version: result.resource.version,
          status,
          supersededId: oldId || null,
        };
        await tx.query(
          "INSERT INTO operations(id,workspace_id,user_id,response) VALUES($1,$2,$3,$4)",
          [
            input.operationId,
            req.params.workspaceId,
            user.id,
            JSON.stringify(response),
          ],
        );
        return response;
      });
    },
  );
}
