import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Connection, Database } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import {
  dashboardConfigSchema,
  dashboardReferenceScopes,
  currentAnalytics,
  reportRange,
  type DashboardConfig,
} from "../shared/analytics.js";
import { validTimeZone } from "../shared/automation.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
export function dashboardHistoryScopes(resource: Resource, all: Resource[]) {
  try {
    return dashboardReferenceScopes(
      dashboardConfigSchema.parse(resource.data.dashboardConfig || {}),
      all,
    );
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}
import {
  historicalAnalytics,
  type HistoricalEntry,
} from "./analytics-history.js";
export function validateDashboardConfig(
  config: DashboardConfig,
  all: Resource[],
  userId: string,
  role: Role,
) {
  if (!validTimeZone(config.timeZone))
    throw new HttpError(400, "La zona horaria del panel no es válida.");
  if (
    new Set(config.widgets).size !== config.widgets.length ||
    new Set(config.projectIds).size !== config.projectIds.length
  )
    throw new HttpError(400, "El panel necesita secciones y proyectos únicos.");
  try {
    reportRange(config);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  for (const id of config.projectIds) {
    const project = all.find(
      (r) => r.id === id && r.kind === "project" && !r.deleted_at,
    );
    if (!project || !canRead(project, userId, role, all))
      throw new HttpError(
        400,
        "Un proyecto del panel no está disponible para esta cuenta.",
      );
  }
}
export function validateDashboardMutation(
  proposed: Resource,
  previous: Resource | undefined,
  all: Resource[],
  userId: string,
  role: Role,
) {
  if (proposed.kind !== "dashboard") {
    if (proposed.data.dashboardConfig !== undefined)
      throw new HttpError(400, "La configuración pertenece a un panel.");
    return;
  }
  if (previous && previous.created_by !== userId && role !== "admin")
    throw new HttpError(
      403,
      "Solo el autor o la administración puede modificar este panel.",
    );
  if (
    proposed.data.projectId ||
    proposed.data.parentId ||
    proposed.data.targetId
  )
    throw new HttpError(
      400,
      "El alcance de un panel se define con sus filtros.",
    );
  if (proposed.deleted_at) return;
  const config = dashboardConfigSchema.parse(
    proposed.data.dashboardConfig || {},
  );
  validateDashboardConfig(config, all, userId, role);
  proposed.data.dashboardConfig = config;
}
export function registerAnalyticsRoutes(
  app: FastifyInstance,
  db: Database,
  userFor: (req: FastifyRequest) => Promise<User>,
) {
  app.post<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/analytics",
    async (req) => {
      const user = await userFor(req),
        config = dashboardConfigSchema.parse(req.body),
        workspaceId = z.string().uuid().parse(req.params.workspaceId);
      return db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const role = (
          await tx.query(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [workspaceId, user.id],
          )
        ).rows[0]?.role as Role | undefined;
        if (!role) throw new HttpError(403, "No tienes acceso a este espacio.");
        const all = (
          await tx.query<Resource>(
            "SELECT * FROM resources WHERE workspace_id=$1",
            [workspaceId],
          )
        ).rows;
        validateDashboardConfig(config, all, user.id, role);
        const permissionMemo = new WeakMap<Resource, boolean>();
        const visible = all.filter((r) =>
            canRead(r, user.id, role, all, new Set(), permissionMemo),
          ),
          current = currentAnalytics(visible, config),
          range = reportRange(config);
        if (current.tasks.length > 2000)
          return {
            available: false,
            reason: "scope_limit",
            permissionScoped: true,
            range,
          };
        const cutoff = new Date(
          Date.parse(range.to + "T00:00:00Z") + 2 * 86400000,
        ).toISOString();
        const projection = `jsonb_build_object('id',v.snapshot->'id','kind',v.snapshot->'kind','workspace_id',v.snapshot->'workspace_id','version',v.snapshot->'version','created_by',v.snapshot->'created_by','created_at',v.snapshot->'created_at','deleted_at',v.snapshot->'deleted_at','data',jsonb_build_object('projectId',v.snapshot->'data'->'projectId','parentId',v.snapshot->'data'->'parentId','targetId',v.snapshot->'data'->'targetId','ownerId',v.snapshot->'data'->'ownerId','private',v.snapshot->'data'->'private','members',CASE WHEN jsonb_typeof(v.snapshot->'data'->'members')='array' AND (v.snapshot->'data'->'members') ? $5::text THEN jsonb_build_array($5::text) ELSE '[]'::jsonb END,'assigneeId',v.snapshot->'data'->'assigneeId','status',v.snapshot->'data'->'status','estimate',v.snapshot->'data'->'estimate'))`;
        const byId = new Map(all.map((r) => [r.id, r])),
          liveIds = new Set(
            visible.filter((r) => !r.deleted_at).map((r) => r.id),
          ),
          requested = new Set(current.tasks.map((t) => t.id)),
          loaded = new Set<string>(),
          versions: HistoricalEntry[] = [];
        const supported = new Set([
          "task",
          "project",
          "folder",
          "document",
          "sprint",
          "team",
          "comment",
          "notification",
          "time_entry",
          "retrospective",
        ]);
        if (!config.projectIds.length)
          for (const sprint of visible.filter(
            (r) =>
              r.kind === "sprint" &&
              !r.deleted_at &&
              r.data.status === "completed" &&
              !(r.data.snapshot || []).length,
          ))
            requested.add(sprint.id);
        while (true) {
          const ids = [...requested].filter(
            (id) =>
              !loaded.has(id) &&
              liveIds.has(id) &&
              supported.has(byId.get(id)?.kind || ""),
          );
          if (!ids.length) break;
          if (requested.size > 2000)
            return {
              available: false,
              reason: "scope_limit",
              permissionScoped: true,
              range,
            };
          ids.forEach((id) => loaded.add(id));
          const rows = (
            await tx.query<HistoricalEntry>(
              `SELECT v.version,${projection} AS snapshot,to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM resource_versions v JOIN resources r ON r.id=v.resource_id WHERE r.workspace_id=$1 AND v.resource_id=ANY($2::uuid[]) AND v.created_at<$3 ORDER BY v.created_at,v.version LIMIT $4`,
              [workspaceId, ids, cutoff, 15001 - versions.length, user.id],
            )
          ).rows;
          versions.push(...rows);
          if (
            versions.filter((v) => v.snapshot.kind === "task").length > 5000 ||
            versions.filter((v) => v.snapshot.kind !== "task").length > 10000
          )
            return {
              available: false,
              reason: "history_limit",
              permissionScoped: true,
              range,
            };
          for (const row of rows)
            for (const id of [
              row.snapshot.data.projectId,
              row.snapshot.data.parentId,
              row.snapshot.data.targetId,
            ])
              if (
                id &&
                liveIds.has(id) &&
                supported.has(byId.get(id)?.kind || "")
              )
                requested.add(id);
        }
        return historicalAnalytics(
          all,
          current.tasks,
          versions,
          user.id,
          role,
          config,
        );
      });
    },
  );
}
