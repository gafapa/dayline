import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Database, Connection } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import { mutationSchema } from "../shared/model.js";
import { fieldDefinitionsSchema } from "../shared/custom-fields.js";
import { structurePath } from "../shared/hierarchy.js";
import { canRead } from "./permissions.js";
import { resources, applyMutation } from "./mutations.js";
import {
  canManageFields,
  checkDefinitions,
  defaultTaskFields,
  validateCustomFieldData,
} from "./custom-field-validation.js";
import { HttpError } from "./errors.js";
const uuid = z.string().uuid();
const inputSchema = z
  .object({
    definitions: fieldDefinitionsSchema,
    expectedVersion: z.number().int().positive(),
    fillMissing: z.boolean().default(false),
  })
  .strict();
export function registerCustomFieldRoutes(
  app: FastifyInstance,
  db: Database,
  userFor: (req: FastifyRequest) => Promise<User>,
) {
  async function context(
    tx: Connection,
    workspaceId: string,
    projectId: string,
    user: User,
  ) {
    await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      workspaceId,
    ]);
    const role = (
        await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
          [workspaceId, user.id],
        )
      ).rows[0]?.role as Role | undefined,
      all = await resources(tx, workspaceId),
      project = all.find(
        (r) => r.id === projectId && r.kind === "project" && !r.deleted_at,
      );
    if (!role || !project || !canRead(project, user.id, role, all))
      throw new HttpError(404, "El proyecto no está disponible.");
    if (!canManageFields(project, user.id, role))
      throw new HttpError(
        403,
        "Solo la administración o la persona que creó el proyecto puede configurar campos.",
      );
    const members = new Set<string>(
      (
        await tx.query(
          "SELECT user_id FROM memberships WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows.map((r) => r.user_id),
    );
    return { role, all, project, members, user, workspaceId };
  }
  type Access = Awaited<ReturnType<typeof context>>;
  async function plan(
    tx: Connection,
    access: Access,
    input: z.infer<typeof inputSchema>,
  ) {
    const { project, all, members, user, role } = access;
    if (project.version !== input.expectedVersion)
      throw new HttpError(
        409,
        "El proyecto ha cambiado. Recarga su configuración.",
      );
    checkDefinitions(
      input.definitions,
      fieldDefinitionsSchema.parse(project.data.fieldDefinitions || []),
      members,
    );
    const nextProject = {
        ...project,
        data: { ...project.data, fieldDefinitions: input.definitions },
      },
      graph = all.map((r) => (r.id === project.id ? nextProject : r)),
      tasks = all.filter(
        (r) =>
          r.kind === "task" && r.data.projectId === project.id && !r.deleted_at,
      ),
      changes: Resource[] = [];
    for (const task of tasks) {
      const candidate = {
        ...task,
        data: defaultTaskFields(
          task.data,
          input.definitions,
          input.fillMissing ? "missing" : "required",
        ),
      };
      try {
        candidate.data = await validateCustomFieldData(
          tx,
          candidate,
          task,
          graph,
          user,
          role,
          { fieldMembers: members },
        );
      } catch {
        throw new HttpError(
          409,
          "La configuración no es compatible con todos los valores guardados. Revisa los límites, los predeterminados y los campos obligatorios.",
        );
      }
      if (
        !isDeepStrictEqual(
          candidate.data.customFields || {},
          task.data.customFields || {},
        )
      ) {
        if (!canRead(task, user.id, role, all))
          throw new HttpError(
            403,
            "No puedes aplicar esta configuración con tus permisos actuales.",
          );
        changes.push(candidate);
      }
    }
    if (changes.length > 1000)
      throw new HttpError(
        413,
        "Configura primero una parte del proyecto: el límite es de 1000 tareas modificadas por operación.",
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          id: project.id,
          version: project.version,
          definitions: input.definitions,
          fillMissing: input.fillMissing,
          tasks: tasks
            .map((r) => [r.id, r.version])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        }),
      )
      .digest("hex");
    return { nextProject, changes, fingerprint };
  }
  app.post<{ Params: { workspaceId: string; projectId: string } }>(
    "/api/workspaces/:workspaceId/projects/:projectId/fields/preview",
    async (req) => {
      const user = await userFor(req),
        workspaceId = uuid.parse(req.params.workspaceId),
        projectId = uuid.parse(req.params.projectId),
        input = inputSchema.parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, workspaceId, projectId, user),
          result = await plan(tx, access, input);
        return {
          fingerprint: result.fingerprint,
          projectId,
          projectVersion: access.project.version,
          changedTaskCount: result.changes.length,
          changedTasks: result.changes.map((r) => ({
            id: r.id,
            title: r.title,
            version: r.version,
          })),
        };
      });
    },
  );
  app.post<{ Params: { workspaceId: string; projectId: string } }>(
    "/api/workspaces/:workspaceId/projects/:projectId/fields/apply",
    async (req) => {
      const user = await userFor(req),
        workspaceId = uuid.parse(req.params.workspaceId),
        projectId = uuid.parse(req.params.projectId),
        input = inputSchema
          .extend({
            operationId: uuid,
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, workspaceId, projectId, user),
          prior = (
            await tx.query("SELECT * FROM operations WHERE id=$1", [
              input.operationId,
            ])
          ).rows[0];
        if (prior) {
          const response = prior.response;
          if (
            prior.user_id !== user.id ||
            prior.workspace_id !== workspaceId ||
            response.command !== "fields_apply" ||
            !isDeepStrictEqual(response.request, {
              ...input,
              definitions: input.definitions,
            })
          )
            throw new HttpError(
              409,
              "Identificador de operación ya utilizado.",
            );
          if (
            response.scopes.some((scope: Resource) => {
              const current = access.all.find((r) => r.id === scope.id);
              return (
                !current ||
                !canRead(current, user.id, access.role, access.all) ||
                !canRead(scope, user.id, access.role, access.all)
              );
            })
          )
            throw new HttpError(
              403,
              "El resultado ya no está disponible para esta cuenta.",
            );
          return {
            command: response.command,
            projectId,
            projectVersion: response.projectVersion,
            changedTaskCount: response.changedTaskCount,
          };
        }
        const result = await plan(tx, access, input);
        if (result.fingerprint !== input.fingerprint)
          throw new HttpError(
            409,
            "Las tareas han cambiado. Revisa de nuevo la configuración.",
          );
        const graph = access.all.map((r) =>
            r.id === projectId
              ? result.nextProject
              : result.changes.find((t) => t.id === r.id) || r,
          ),
          projectResult = await applyMutation(
            tx,
            workspaceId,
            user,
            access.role,
            mutationSchema.parse({
              id: projectId,
              kind: "project",
              title: access.project.title,
              data: result.nextProject.data,
              expectedVersion: access.project.version,
              operationId: randomUUID(),
            }),
            {
              skipOperation: true,
              graph,
              existing: access.project,
              fieldAdministration: true,
              fieldMembers: access.members,
            },
          );
        graph.splice(
          graph.findIndex((r) => r.id === projectId),
          1,
          projectResult.resource,
        );
        for (const task of result.changes) {
          const old = access.all.find((r) => r.id === task.id)!;
          const updated = await applyMutation(
            tx,
            workspaceId,
            user,
            access.role,
            mutationSchema.parse({
              id: task.id,
              kind: "task",
              title: task.title,
              data: { ...task.data, fieldSnapshots: old.data.fieldSnapshots },
              expectedVersion: old.version,
              operationId: randomUUID(),
            }),
            {
              skipOperation: true,
              graph,
              existing: old,
              fieldMembers: access.members,
            },
          );
          graph.splice(
            graph.findIndex((r) => r.id === task.id),
            1,
            updated.resource,
          );
        }
        const scopes = new Map<string, Resource>();
        for (const r of [access.project, ...result.changes])
          for (const scope of structurePath(r.id, access.all))
            scopes.set(scope.id, scope);
        const response = {
          command: "fields_apply",
          request: input,
          projectId,
          projectVersion: projectResult.resource.version,
          changedTaskCount: result.changes.length,
          scopes: [...scopes.values()].map((r) => ({
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
        return {
          command: response.command,
          projectId,
          projectVersion: response.projectVersion,
          changedTaskCount: response.changedTaskCount,
        };
      });
    },
  );
}
