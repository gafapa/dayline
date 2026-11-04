import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Connection } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import { mutationSchema } from "../shared/model.js";
import {
  isStructure,
  acceptsChild,
  structurePath,
  structureBranch,
  projectAt,
  type MovePreview,
} from "../shared/hierarchy.js";
import { canRead } from "./permissions.js";
import { applyMutation, resources } from "./mutations.js";
import { HttpError } from "./errors.js";
const uuid = z.string().uuid(),
  inputSchema = z.object({ id: uuid, destinationId: uuid.nullable() }).strict();
export function registerHierarchyRoutes(
  app: FastifyInstance,
  db: Database,
  userFor: (req: FastifyRequest) => Promise<User>,
) {
  async function context(tx: Connection, workspaceId: string, user: User) {
    await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      workspaceId,
    ]);
    const role = (
      await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
        [workspaceId, user.id],
      )
    ).rows[0]?.role as Role | undefined;
    if (!role || role === "viewer")
      throw new HttpError(403, "Se requiere acceso de edición.");
    return { all: await resources(tx, workspaceId), role, user, workspaceId };
  }
  type Access = Awaited<ReturnType<typeof context>>;
  function plan(access: Access, input: z.infer<typeof inputSchema>) {
    const { all, user, role } = access,
      root = all.find((r) => r.id === input.id && !r.deleted_at),
      destination = input.destinationId
        ? all.find((r) => r.id === input.destinationId && !r.deleted_at)
        : null;
    if (!root || !isStructure(root) || !canRead(root, user.id, role, all))
      throw new HttpError(404, "La estructura no está disponible.");
    if (
      input.destinationId &&
      (!destination ||
        destination.data.archived ||
        !acceptsChild(destination.kind, root.kind) ||
        !canRead(destination, user.id, role, all))
    )
      throw new HttpError(404, "La ubicación no está disponible.");
    if (root.data.archived)
      throw new HttpError(409, "Desarchiva el elemento antes de moverlo.");
    if (
      destination &&
      structurePath(destination.id, all).some(
        (r) => r.deleted_at || r.data.archived,
      )
    )
      throw new HttpError(404, "La ubicación no está disponible.");
    const branch = structureBranch(root.id, all);
    if (branch.length > 1000)
      throw new HttpError(
        413,
        "Mueve una parte más pequeña de la estructura: el límite por operación es de 1000 elementos.",
      );
    if (branch.some((r) => !canRead(r, user.id, role, all)))
      throw new HttpError(
        403,
        "No se puede mover esta estructura con tus permisos actuales.",
      );
    if (destination && branch.some((r) => r.id === destination.id))
      throw new HttpError(
        400,
        "No puedes mover un elemento dentro de su propia estructura.",
      );
    const graph = structuredClone(all),
      byId = new Map(graph.map((r) => [r.id, r]));
    const nextRoot = byId.get(root.id)!;
    nextRoot.data.parentId = destination?.id || null;
    if (root.kind !== "project")
      nextRoot.data.projectId = projectAt(destination?.id || null, graph);
    const ordered = [...branch].sort(
      (a, b) =>
        structurePath(a.id, graph).length - structurePath(b.id, graph).length,
    );
    for (const original of ordered) {
      const next = byId.get(original.id)!;
      if (next.kind === "project") continue;
      if (next.id === root.id) continue;
      if (next.data.parentId)
        next.data.projectId = projectAt(next.data.parentId, graph);
    }
    if (branch.some((r) => !canRead(byId.get(r.id)!, user.id, role, graph)))
      throw new HttpError(
        403,
        "La ubicación no permite conservar el acceso a toda la estructura.",
      );
    const changed = ordered.filter(
      (r) => JSON.stringify(r.data) !== JSON.stringify(byId.get(r.id)!.data),
    );
    const scoped = new Map(branch.map((r) => [r.id, r]));
    for (const id of [root.id, destination?.id])
      if (id) for (const r of structurePath(id, all)) scoped.set(r.id, r);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          id: root.id,
          destinationId: input.destinationId,
          scopes: [...scoped.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((r) => [
              r.id,
              r.version,
              r.deleted_at,
              r.data.parentId || null,
              r.data.projectId || null,
            ]),
        }),
      )
      .digest("hex");
    const preview: MovePreview = {
      ...input,
      fingerprint,
      title: root.title,
      destinationTitle: destination?.title || "Raíz del espacio",
      affectedCount: branch.length,
      changes: changed.map((r) => {
        const next = byId.get(r.id)!;
        return {
          id: r.id,
          title: r.title,
          kind: r.kind,
          version: r.version,
          parentId: next.data.parentId || null,
          projectId: next.data.projectId || null,
        };
      }),
    };
    return {
      preview,
      changed: changed.map((r) => byId.get(r.id)!),
      scopes: [...scoped.values()],
    };
  }
  const safePlan = (access: Access, input: z.infer<typeof inputSchema>) => {
    try {
      return plan(access, input);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "La estructura no es válida.",
      );
    }
  };
  app.post<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/hierarchy/preview",
    async (req) => {
      const user = await userFor(req),
        input = inputSchema.parse(req.body),
        workspaceId = uuid.parse(req.params.workspaceId);
      return db.transaction(
        async (tx) =>
          safePlan(await context(tx, workspaceId, user), input).preview,
      );
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/hierarchy/move",
    async (req) => {
      const user = await userFor(req),
        input = inputSchema
          .extend({
            operationId: uuid,
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(req.body),
        workspaceId = uuid.parse(req.params.workspaceId);
      return db.transaction(async (tx) => {
        const access = await context(tx, workspaceId, user),
          prior = (
            await tx.query("SELECT * FROM operations WHERE id=$1", [
              input.operationId,
            ])
          ).rows[0];
        if (prior) {
          const result = prior.response;
          if (
            prior.user_id !== user.id ||
            prior.workspace_id !== workspaceId ||
            result.command !== "hierarchy_move" ||
            result.request.id !== input.id ||
            result.request.destinationId !== input.destinationId ||
            result.request.fingerprint !== input.fingerprint
          )
            throw new HttpError(
              409,
              "Identificador de operación ya utilizado.",
            );
          if (
            result.scopes.some((scope: Resource) => {
              const current = access.all.find((r) => r.id === scope.id);
              return (
                !current ||
                !canRead(scope, user.id, access.role, access.all) ||
                !canRead(current, user.id, access.role, access.all)
              );
            })
          )
            throw new HttpError(
              403,
              "El resultado ya no está disponible para esta cuenta.",
            );
          return {
            command: result.command,
            ids: result.ids,
            preview: result.preview,
          };
        }
        const current = safePlan(access, input);
        if (current.preview.fingerprint !== input.fingerprint)
          throw new HttpError(
            409,
            "La estructura ha cambiado. Revisa de nuevo el movimiento.",
          );
        const graph = [...access.all],
          ids: string[] = [];
        for (const next of current.changed) {
          const result = await applyMutation(
            tx,
            workspaceId,
            user,
            access.role,
            mutationSchema.parse({
              id: next.id,
              operationId: randomUUID(),
              kind: next.kind,
              title: next.title,
              data: next.data,
              deleted: !!next.deleted_at,
              expectedVersion: next.version,
            }),
            { skipOperation: true, graph, hierarchyMove: true },
          );
          graph.splice(
            graph.findIndex((r) => r.id === next.id),
            1,
            result.resource,
          );
          ids.push(next.id);
        }
        const response = {
          command: "hierarchy_move",
          request: input,
          ids,
          preview: current.preview,
          scopes: current.scopes.map((r) => ({
            ...r,
            data: Object.fromEntries(
              Object.entries(r.data).filter(([key]) =>
                [
                  "parentId",
                  "projectId",
                  "targetId",
                  "ownerId",
                  "private",
                  "members",
                  "assigneeId",
                ].includes(key),
              ),
            ),
          })),
        };
        await tx.query(
          "INSERT INTO operations(id,workspace_id,user_id,response) VALUES($1,$2,$3,$4)",
          [input.operationId, workspaceId, user.id, JSON.stringify(response)],
        );
        return { command: response.command, ids, preview: response.preview };
      });
    },
  );
}
