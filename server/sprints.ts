import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Connection, Database } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import {
  capacityPlanSchema,
  ceremonySchema,
  emptyCeremony,
  pokerDeck,
  sprintMetrics,
  type Ceremony,
} from "../shared/sprints.js";
import { validDay } from "../shared/automation.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import { notifyChange } from "./notifications.js";
import { enqueueTaskEvents } from "./automations.js";
const uuid = z.string().uuid(),
  version = z.number().int().min(0);
const list = async (tx: Connection, workspaceId: string, light = false) =>
  (
    await tx.query<Resource>(
      light
        ? "SELECT id,workspace_id,kind,title,data-'content'-'description'-'snapshot' AS data,version,created_by,created_at,updated_at,deleted_at FROM resources WHERE workspace_id=$1"
        : "SELECT * FROM resources WHERE workspace_id=$1",
      [workspaceId],
    )
  ).rows;
const sprintTasks = (all: Resource[], id: string) =>
  all.filter(
    (r) => r.kind === "task" && r.data.sprintId === id && !r.deleted_at,
  );

export async function validateSprintMutation(
  tx: Connection,
  proposed: Resource,
  previous: Resource | undefined,
  all: Resource[],
  userId: string,
  role: Role,
) {
  if (proposed.deleted_at) return;
  if (proposed.kind === "sprint") {
    for (const field of ["startDate", "endDate"])
      if (proposed.data[field] && !validDay(proposed.data[field]))
        throw new HttpError(400, "Las fechas del sprint no son válidas.");
    if (
      proposed.data.startDate &&
      proposed.data.endDate &&
      proposed.data.endDate < proposed.data.startDate
    )
      throw new HttpError(400, "El sprint debe terminar después de comenzar.");
    if (
      previous?.data.status === "active" &&
      proposed.data.status === "planned"
    )
      throw new HttpError(
        409,
        "Un sprint iniciado conserva su historial de inicio.",
      );
    if (
      proposed.data.status === "active" &&
      previous?.data.status !== "active" &&
      sprintTasks(all, proposed.id).some(
        (task) => !canRead(task, userId, role, all),
      )
    )
      throw new HttpError(
        403,
        "Necesitas acceso a todas las tareas para iniciar el sprint.",
      );
    const capacity = proposed.data.capacityPlan || [];
    if (
      new Set(capacity.map((entry: any) => entry.userId)).size !==
      capacity.length
    )
      throw new HttpError(400, "Hay personas duplicadas en la capacidad.");
    const members = (
      await tx.query("SELECT user_id FROM memberships WHERE workspace_id=$1", [
        proposed.workspace_id,
      ])
    ).rows;
    for (const entry of capacity)
      if (
        !members.some((member) => member.user_id === entry.userId) &&
        !previous?.data.capacityPlan?.some(
          (old: any) => JSON.stringify(old) === JSON.stringify(entry),
        )
      )
        throw new HttpError(
          400,
          "La capacidad debe corresponder a miembros del espacio.",
        );
  }
  if (
    proposed.kind === "task" &&
    proposed.data.sprintId &&
    proposed.data.sprintId !== previous?.data.sprintId
  ) {
    const target = all.find((r) => r.id === proposed.data.sprintId);
    if (target?.data.status === "completed")
      throw new HttpError(409, "No puedes añadir tareas a un sprint cerrado.");
  }
}
export async function captureSprintBaseline(
  tx: Connection,
  sprint: Resource,
  previous: Resource | undefined,
  all: Resource[],
) {
  if (
    sprint.kind === "sprint" &&
    !sprint.deleted_at &&
    sprint.data.status === "active" &&
    previous?.data.status !== "active"
  )
    await tx.query(
      "INSERT INTO sprint_baselines(sprint_id,tasks,capacity_plan) VALUES($1,$2,$3) ON CONFLICT(sprint_id) DO NOTHING",
      [
        sprint.id,
        JSON.stringify(sprintTasks(all, sprint.id)),
        JSON.stringify(sprint.data.capacityPlan || []),
      ],
    );
}
async function record(
  tx: Connection,
  resource: Resource,
  actorId: string,
  action: string,
) {
  await tx.query(
    "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) VALUES($1,$2,$3,$4)",
    [resource.id, resource.version, JSON.stringify(resource), actorId],
  );
  await tx.query(
    "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,$4)",
    [resource.workspace_id, resource.id, actorId, action],
  );
}

export function registerSprintRoutes(
  app: FastifyInstance,
  db: Database,
  userFor: (req: FastifyRequest) => Promise<User>,
) {
  type Params = { workspaceId: string; sprintId: string };
  async function context(
    tx: Connection,
    params: Params,
    user: User,
    write = false,
    light = false,
  ) {
    const workspaceId = uuid.parse(params.workspaceId),
      sprintId = uuid.parse(params.sprintId);
    if (write)
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspaceId,
      ]);
    const membership = (
      await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2" +
          (write ? " FOR UPDATE" : ""),
        [workspaceId, user.id],
      )
    ).rows[0];
    if (
      !membership ||
      (write && !["admin", "member"].includes(membership.role))
    )
      throw new HttpError(403, "Se requiere acceso de edición del equipo.");
    const role = membership.role as Role,
      all = await list(tx, workspaceId, light),
      sprint = all.find(
        (r) => r.id === sprintId && r.kind === "sprint" && !r.deleted_at,
      );
    if (!sprint || !canRead(sprint, user.id, role, all))
      throw new HttpError(404, "No se encuentra el sprint.");
    const visible = (r: Resource) => canRead(r, user.id, role, all);
    return { workspaceId, sprint, user, role, all, visible };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  const historical = (task: Resource, access: Context) =>
    access.all.some(
      (current) => current.id === task.id && access.visible(current),
    ) && canRead(task, access.user.id, access.role, access.all);
  const sanitizeCeremony = (data: Ceremony, access: Context) => ({
    ...data,
    retrospective: {
      ...data.retrospective,
      actionIds: data.retrospective.actionIds.filter((id) =>
        access.all.some((r) => r.id === id && access.visible(r)),
      ),
    },
  });
  async function prior(
    tx: Connection,
    id: string,
    access: Context,
    command: string,
  ) {
    const row = (await tx.query("SELECT * FROM operations WHERE id=$1", [id]))
      .rows[0];
    if (!row) return null;
    if (
      row.workspace_id !== access.workspaceId ||
      row.user_id !== access.user.id ||
      row.response.command !== command
    )
      throw new HttpError(409, "Identificador de operación ya utilizado.");
    return row.response;
  }
  async function remember(
    tx: Connection,
    id: string,
    access: Context,
    command: string,
    response: any,
  ) {
    const result = { ...response, command };
    await tx.query(
      "INSERT INTO operations(id,workspace_id,user_id,response) VALUES($1,$2,$3,$4)",
      [id, access.workspaceId, access.user.id, JSON.stringify(result)],
    );
    return result;
  }
  app.get<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/planning",
    async (req) => {
      const access = await context(db, req.params, await userFor(req));
      const tasks =
        access.sprint.data.status === "completed"
          ? (access.sprint.data.snapshot || []).filter((task: Resource) =>
              historical(task, access),
            )
          : sprintTasks(access.all, access.sprint.id).filter(access.visible);
      const candidates = access.all.filter(
        (task) =>
          task.kind === "task" &&
          !task.deleted_at &&
          access.visible(task) &&
          (!task.data.sprintId ||
            task.data.sprintId === access.sprint.id ||
            access.all.some(
              (sprint) =>
                sprint.id === task.data.sprintId &&
                sprint.data.status === "planned",
            )) &&
          !["done", "cancelled"].includes(task.data.status),
      );
      const baseline = (
        await db.query("SELECT * FROM sprint_baselines WHERE sprint_id=$1", [
          access.sprint.id,
        ])
      ).rows[0];
      return {
        sprint: access.sprint,
        tasks,
        candidates,
        baseline: baseline
          ? {
              ...baseline,
              tasks: baseline.tasks.filter((task: Resource) =>
                historical(task, access),
              ),
            }
          : null,
        canEdit:
          ["admin", "member"].includes(access.role) &&
          access.sprint.data.status !== "completed",
        permissionScoped: true,
        canReview: ["admin", "member"].includes(access.role),
      };
    },
  );
  app.put<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/planning",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: uuid,
            expectedVersion: version,
            taskIds: z.array(uuid).max(500),
            taskVersions: z.array(z.object({ id: uuid, version })).max(1000),
            capacityPlan: capacityPlanSchema,
            definitionOfDone: z.string().max(100000),
            checklist: z
              .array(
                z.object({
                  id: z.string().max(80),
                  text: z.string().max(500),
                  done: z.boolean(),
                }),
              )
              .max(300),
          })
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params, user, true),
          previous = await prior(tx, input.operationId, access, "sprint_plan");
        if (previous) return previous;
        if (
          access.sprint.data.status === "completed" ||
          access.sprint.version !== input.expectedVersion
        )
          throw new HttpError(
            409,
            "El sprint cambió. Recarga la planificación; tu borrador se conserva.",
          );
        if (
          new Set(input.taskIds).size !== input.taskIds.length ||
          new Set(input.taskVersions.map((t) => t.id)).size !==
            input.taskVersions.length
        )
          throw new HttpError(400, "Hay tareas duplicadas en el plan.");
        const current = sprintTasks(access.all, access.sprint.id),
          ids = new Set([...input.taskIds, ...current.map((task) => task.id)]);
        for (const id of ids) {
          const task = access.all.find(
            (task) => task.id === id && !task.deleted_at,
          );
          if (!task || task.kind !== "task" || !access.visible(task))
            throw new HttpError(
              403,
              "Necesitas acceso a todas las tareas del plan.",
            );
          if (
            input.taskVersions.find((v) => v.id === id)?.version !==
            task.version
          )
            throw new HttpError(
              409,
              "Una tarea del plan cambió. Recarga antes de aplicar la planificación.",
            );
          if (
            task.data.sprintId &&
            task.data.sprintId !== access.sprint.id &&
            access.all.find((r) => r.id === task.data.sprintId)?.data.status !==
              "planned"
          )
            throw new HttpError(
              409,
              "Saca primero la tarea de su sprint actual.",
            );
        }
        const proposed = {
          ...access.sprint,
          data: {
            ...access.sprint.data,
            capacityPlan: input.capacityPlan,
            definitionOfDone: input.definitionOfDone,
            checklist: input.checklist,
          },
        };
        await validateSprintMutation(
          tx,
          proposed,
          access.sprint,
          access.all,
          user.id,
          access.role,
        );
        for (const id of ids) {
          const task = access.all.find((task) => task.id === id)!,
            order = input.taskIds.indexOf(id),
            data = {
              ...task.data,
              sprintId: order >= 0 ? access.sprint.id : null,
              ...(order >= 0 ? { order: order * 1024 } : {}),
            };
          if (JSON.stringify(data) === JSON.stringify(task.data)) continue;
          const result = (
            await tx.query<Resource>(
              "UPDATE resources SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
              [JSON.stringify(data), id],
            )
          ).rows[0];
          await record(tx, result, user.id, "sprint_scope_changed");
          await notifyChange(tx, result, task, access.all, user.id);
          await enqueueTaskEvents(tx, result, task, access.all, user.id);
        }
        const result = (
          await tx.query<Resource>(
            "UPDATE resources SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
            [JSON.stringify(proposed.data), access.sprint.id],
          )
        ).rows[0];
        await record(tx, result, user.id, "sprint_planned");
        return remember(tx, input.operationId, access, "sprint_plan", {
          resource: result,
        });
      });
    },
  );
  app.post<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/start",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({ operationId: uuid, expectedVersion: version })
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params, user, true),
          previous = await prior(tx, input.operationId, access, "sprint_start");
        if (previous) return previous;
        if (
          access.sprint.version !== input.expectedVersion ||
          access.sprint.data.status !== "planned"
        )
          throw new HttpError(409, "El sprint cambió o ya fue iniciado.");
        const proposed = {
          ...access.sprint,
          data: { ...access.sprint.data, status: "active" },
        };
        await validateSprintMutation(
          tx,
          proposed,
          access.sprint,
          access.all,
          user.id,
          access.role,
        );
        const result = (
          await tx.query<Resource>(
            "UPDATE resources SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
            [JSON.stringify(proposed.data), access.sprint.id],
          )
        ).rows[0];
        await captureSprintBaseline(tx, result, access.sprint, access.all);
        await record(tx, result, user.id, "sprint_started");
        return remember(tx, input.operationId, access, "sprint_start", {
          resource: result,
        });
      });
    },
  );
  app.get<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/metrics",
    async (req) => {
      const access = await context(db, req.params, await userFor(req)),
        baseline = (
          await db.query("SELECT * FROM sprint_baselines WHERE sprint_id=$1", [
            access.sprint.id,
          ])
        ).rows[0];
      if (!baseline)
        return {
          available: false,
          reason: "no_baseline",
          permissionScoped: true,
        };
      const ids = access.all
        .filter((r) => r.kind === "task" && access.visible(r))
        .map((r) => r.id);
      const history = (
        await db.query(
          `SELECT v.version,jsonb_set(v.snapshot,'{data}',jsonb_build_object('projectId',v.snapshot->'data'->'projectId','parentId',v.snapshot->'data'->'parentId','targetId',v.snapshot->'data'->'targetId','ownerId',v.snapshot->'data'->'ownerId','status',v.snapshot->'data'->'status','estimate',v.snapshot->'data'->'estimate','sprintId',v.snapshot->'data'->'sprintId')) AS snapshot,v.created_at FROM resource_versions v WHERE v.resource_id=ANY($1::uuid[]) AND (v.resource_id IN (SELECT resource_id FROM resource_versions WHERE snapshot->'data'->>'sprintId'=$2) OR v.resource_id=ANY($3::uuid[])) ORDER BY v.created_at,v.resource_id,v.version LIMIT 10001`,
          [
            ids,
            access.sprint.id,
            baseline.tasks.map((task: Resource) => task.id),
          ],
        )
      ).rows;
      if (history.length > 10000)
        return {
          available: false,
          reason: "history_limit",
          permissionScoped: true,
        };
      const visible = new Set(ids),
        tasks = baseline.tasks.filter(
          (task: Resource) => visible.has(task.id) && historical(task, access),
        ),
        closed =
          access.sprint.data.status === "completed"
            ? (access.sprint.data.snapshot || []).filter(
                (task: Resource) =>
                  visible.has(task.id) && historical(task, access),
              )
            : undefined;
      return {
        available: true,
        permissionScoped: true,
        ...sprintMetrics(
          access.sprint.id,
          tasks,
          new Date(baseline.started_at).toISOString(),
          history
            .filter((v) =>
              canRead(v.snapshot, access.user.id, access.role, access.all),
            )
            .map((v) => ({
              ...v,
              created_at: new Date(v.created_at).toISOString(),
            })),
          access.sprint.data.closedAt || new Date().toISOString(),
          closed,
        ),
      };
    },
  );
  app.get<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/ceremonies",
    async (req) => {
      const access = await context(db, req.params, await userFor(req)),
        current = (
          await db.query("SELECT * FROM sprint_ceremonies WHERE sprint_id=$1", [
            access.sprint.id,
          ])
        ).rows[0];
      return {
        version: current?.version || 0,
        data: sanitizeCeremony(current?.data || emptyCeremony(), access),
        updatedAt: current?.updated_at || null,
      };
    },
  );
  app.get<{ Params: Params; Querystring: { before?: string } }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/ceremonies/versions",
    async (req) => {
      const access = await context(db, req.params, await userFor(req)),
        before = req.query.before
          ? z.coerce.number().int().positive().parse(req.query.before)
          : 2147483647;
      const versions = (
        await db.query(
          "SELECT version,data,created_at FROM sprint_ceremony_versions WHERE sprint_id=$1 AND version<$2 ORDER BY version DESC LIMIT 50",
          [access.sprint.id, before],
        )
      ).rows.map((row) => ({
        ...row,
        data: sanitizeCeremony(row.data, access),
      }));
      return {
        versions,
        nextBefore:
          versions.length === 50 ? versions[versions.length - 1].version : null,
      };
    },
  );
  app.put<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/ceremonies",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: uuid,
            expectedVersion: version,
            data: ceremonySchema,
          })
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params, user, true),
          previous = await prior(
            tx,
            input.operationId,
            access,
            "sprint_ceremonies",
          );
        if (previous)
          return { ...previous, data: sanitizeCeremony(previous.data, access) };
        const current = (
          await tx.query(
            "SELECT version FROM sprint_ceremonies WHERE sprint_id=$1 FOR UPDATE",
            [access.sprint.id],
          )
        ).rows[0];
        if ((current?.version || 0) !== input.expectedVersion)
          throw new HttpError(
            409,
            "La revisión cambió. Recarga los datos antes de sustituirla.",
          );
        if (
          input.data.retrospective.actionIds.some(
            (id) =>
              !access.all.some(
                (r) =>
                  r.id === id &&
                  r.kind === "task" &&
                  !r.deleted_at &&
                  access.visible(r),
              ),
          )
        )
          throw new HttpError(
            400,
            "Las acciones deben ser tareas accesibles del espacio.",
          );
        const result = (
          await tx.query(
            "INSERT INTO sprint_ceremonies(sprint_id,version,data,updated_by) VALUES($1,1,$2,$3) ON CONFLICT(sprint_id) DO UPDATE SET version=sprint_ceremonies.version+1,data=EXCLUDED.data,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *",
            [access.sprint.id, JSON.stringify(input.data), user.id],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO sprint_ceremony_versions(sprint_id,version,data,user_id) VALUES($1,$2,$3,$4)",
          [
            access.sprint.id,
            result.version,
            JSON.stringify(result.data),
            user.id,
          ],
        );
        await tx.query(
          "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,'sprint_review_updated')",
          [access.workspaceId, access.sprint.id, user.id],
        );
        return remember(tx, input.operationId, access, "sprint_ceremonies", {
          version: result.version,
          data: result.data,
        });
      });
    },
  );
  async function roundFor(tx: Connection, access: Context, roundId: string) {
    const round = (
        await tx.query(
          "SELECT * FROM poker_rounds WHERE id=$1 AND sprint_id=$2 FOR UPDATE",
          [uuid.parse(roundId), access.sprint.id],
        )
      ).rows[0],
      task = access.all.find((r) => r.id === round?.task_id && !r.deleted_at);
    if (
      !round ||
      !task ||
      !access.visible(task) ||
      (round.task_scope?.id &&
        !canRead(round.task_scope, access.user.id, access.role, access.all))
    )
      throw new HttpError(404, "No se encuentra la ronda.");
    return { round, task };
  }
  async function publicRound(
    tx: Connection,
    round: any,
    access: Context,
    allVotes?: any[],
  ) {
    const task = access.all.find((r) => r.id === round.task_id);
    if (
      !task ||
      task.deleted_at ||
      !access.visible(task) ||
      (round.task_scope?.id &&
        !canRead(round.task_scope, access.user.id, access.role, access.all))
    )
      return null;
    const rows = (
      allVotes
        ? allVotes.filter((v) => v.round_id === round.id)
        : (
            await tx.query(
              "SELECT v.user_id,v.value,m.role FROM poker_votes v JOIN memberships m ON m.user_id=v.user_id WHERE v.round_id=$1 AND m.workspace_id=$2",
              [round.id, access.workspaceId],
            )
          ).rows
    ).filter((v) => canRead(task, v.user_id, v.role, access.all));
    return {
      ...round,
      applied_estimate:
        round.applied_estimate === null ? null : Number(round.applied_estimate),
      ownVote: rows.find((v) => v.user_id === access.user.id)?.value || null,
      participants: rows.map((v) => ({
        userId: v.user_id,
        ...(round.revealed_at || round.status === "applied"
          ? { value: v.value }
          : {}),
      })),
      canFacilitate:
        access.role === "admin" ||
        (round.facilitator_id === access.user.id && access.role === "member"),
    };
  }
  app.get<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/poker",
    async (req) => {
      const access = await context(
          db,
          req.params,
          await userFor(req),
          false,
          true,
        ),
        rounds = (
          await db.query(
            "SELECT * FROM poker_rounds WHERE sprint_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
            [access.sprint.id],
          )
        ).rows,
        votes = (
          await db.query(
            "SELECT v.round_id,v.user_id,v.value,m.role FROM poker_votes v JOIN memberships m ON m.user_id=v.user_id WHERE v.round_id=ANY($1::uuid[]) AND m.workspace_id=$2",
            [rounds.map((round) => round.id), access.workspaceId],
          )
        ).rows;
      return {
        rounds: (
          await Promise.all(
            rounds.map((round) => publicRound(db, round, access, votes)),
          )
        ).filter(Boolean),
        deck: pokerDeck,
        canVote: access.role !== "viewer",
        canCreate:
          ["admin", "member"].includes(access.role) &&
          access.sprint.data.status !== "completed",
      };
    },
  );
  app.post<{ Params: Params }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/poker",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: uuid,
            taskId: uuid,
            expectedTaskVersion: version,
          })
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params, user, true),
          previous = await prior(tx, input.operationId, access, "poker_create");
        if (previous) {
          const current = await roundFor(tx, access, previous.round.id);
          return { round: await publicRound(tx, current.round, access) };
        }
        const task = access.all.find(
          (r) =>
            r.id === input.taskId &&
            r.kind === "task" &&
            !r.deleted_at &&
            r.data.sprintId === access.sprint.id,
        );
        if (!task || !access.visible(task))
          throw new HttpError(404, "La tarea no pertenece a este sprint.");
        if (access.sprint.data.status === "completed")
          throw new HttpError(409, "El sprint está cerrado.");
        if (task.version !== input.expectedTaskVersion)
          throw new HttpError(
            409,
            "La tarea cambió antes de iniciar la estimación.",
          );
        if (
          (
            await tx.query(
              "SELECT id FROM poker_rounds WHERE sprint_id=$1 AND status IN ('voting','revealed')",
              [access.sprint.id],
            )
          ).rows.length
        )
          throw new HttpError(
            409,
            "Termina o cancela la ronda abierta antes de crear otra.",
          );
        const round = (
          await tx.query(
            "INSERT INTO poker_rounds(id,sprint_id,task_id,facilitator_id,task_version,task_scope) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              randomUUID(),
              access.sprint.id,
              task.id,
              user.id,
              task.version,
              JSON.stringify({
                ...task,
                title: "",
                data: Object.fromEntries(
                  ["projectId", "parentId", "targetId", "ownerId"]
                    .filter((key) => task.data[key])
                    .map((key) => [key, task.data[key]]),
                ),
              }),
            ],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,'poker_started')",
          [access.workspaceId, task.id, user.id],
        );
        return remember(tx, input.operationId, access, "poker_create", {
          round,
        });
      });
    },
  );
  app.put<{ Params: Params & { roundId: string } }>(
    "/api/workspaces/:workspaceId/sprints/:sprintId/poker/:roundId/vote",
    async (req) => {
      const user = await userFor(req),
        input = z.object({ value: z.enum(pokerDeck) }).parse(req.body);
      return db.transaction(async (tx) => {
        // Guests can vote on visible work; workspace management remains member/admin-only.
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          uuid.parse(req.params.workspaceId),
        ]);
        const access = await context(tx, req.params, user),
          { round, task } = await roundFor(tx, access, req.params.roundId);
        if (access.role === "viewer")
          throw new HttpError(403, "Tu acceso es de solo lectura.");
        if (
          round.status !== "voting" ||
          access.sprint.data.status === "completed" ||
          task.data.sprintId !== access.sprint.id
        )
          throw new HttpError(409, "La ronda ya no admite votos.");
        await tx.query(
          "INSERT INTO poker_votes(round_id,user_id,value) VALUES($1,$2,$3) ON CONFLICT(round_id,user_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
          [round.id, user.id, input.value],
        );
        return { saved: true };
      });
    },
  );
  for (const action of ["reveal", "cancel", "apply"] as const)
    app.post<{ Params: Params & { roundId: string } }>(
      `/api/workspaces/:workspaceId/sprints/:sprintId/poker/:roundId/${action}`,
      async (req) => {
        const user = await userFor(req),
          input = z
            .object({
              operationId: uuid,
              expectedVersion: version,
              estimate: z.number().min(0).max(10000).optional(),
              expectedTaskVersion: version.optional(),
            })
            .parse(req.body);
        return db.transaction(async (tx) => {
          const access = await context(tx, req.params, user, true),
            { round, task } = await roundFor(tx, access, req.params.roundId);
          if (access.role !== "admin" && round.facilitator_id !== user.id)
            throw new HttpError(
              403,
              "Solo quien facilita la ronda puede realizar esta acción.",
            );
          const previous = await prior(
            tx,
            input.operationId,
            access,
            "poker_" + action,
          );
          if (previous) return { round: await publicRound(tx, round, access) };
          if (
            access.sprint.data.status === "completed" ||
            round.version !== input.expectedVersion
          )
            throw new HttpError(409, "La ronda cambió. Actualiza sus datos.");
          if (
            (action === "reveal" && round.status !== "voting") ||
            (action === "apply" && round.status !== "revealed") ||
            (action === "cancel" &&
              !["voting", "revealed"].includes(round.status))
          )
            throw new HttpError(409, "La ronda ya no permite esta acción.");
          if (action === "apply") {
            if (
              input.estimate === undefined ||
              input.expectedTaskVersion !== task.version
            )
              throw new HttpError(
                409,
                "La tarea cambió. Revisa su estimación actual antes de aplicar el consenso.",
              );
            if (task.data.sprintId !== access.sprint.id)
              throw new HttpError(409, "La tarea salió del sprint.");
            const data = { ...task.data, estimate: input.estimate },
              result = (
                await tx.query<Resource>(
                  "UPDATE resources SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
                  [JSON.stringify(data), task.id],
                )
              ).rows[0];
            await record(tx, result, user.id, "poker_estimate_applied");
            await notifyChange(tx, result, task, access.all, user.id);
            await enqueueTaskEvents(tx, result, task, access.all, user.id);
          }
          const updated = (
            await tx.query(
              "UPDATE poker_rounds SET status=$2,version=version+1,revealed_at=CASE WHEN $2='revealed' THEN now() ELSE revealed_at END,applied_at=CASE WHEN $2='applied' THEN now() ELSE applied_at END,applied_estimate=CASE WHEN $2='applied' THEN $3 ELSE applied_estimate END WHERE id=$1 RETURNING *",
              [
                round.id,
                action === "reveal"
                  ? "revealed"
                  : action === "cancel"
                    ? "cancelled"
                    : "applied",
                input.estimate ?? null,
              ],
            )
          ).rows[0];
          return remember(tx, input.operationId, access, "poker_" + action, {
            round: await publicRound(tx, updated, access),
          });
        });
      },
    );
}
