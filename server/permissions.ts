import type { Resource, Role } from "../shared/model.js";
import { scopeResource } from "../shared/collections.js";
import { deliveryIds, isDelivery } from "../shared/delivery.js";
export function canRead(
  resource: Resource,
  userId: string,
  role: Role,
  all: Resource[],
  visited = new Set<string>(),
  memo = new WeakMap<Resource, boolean>(),
): boolean {
  if (visited.has(resource.id) || visited.size > 512) return false;
  const cached = memo.get(resource);
  if (cached !== undefined) return cached;
  const result = evaluate();
  memo.set(resource, result);
  return result;
  function evaluate(): boolean {
    visited.add(resource.id);
    if (resource.kind === "reminder" && resource.created_by !== userId) return false;
    if (
      resource.data.personalNote &&
      (resource.kind !== "document" || resource.created_by !== userId)
    )
      return false;
    if (resource.data.ownerId && resource.data.ownerId !== userId) return false;
    if (resource.kind === "time_entry") {
      for (const scopes of resource.data.timeLogContexts || []) {
        const snapshots = new Map(
          scopes.map((scope: any) => [scope.id, scope]),
        );
        const historic = all.map((item) =>
          snapshots.has(item.id)
            ? scopeResource(snapshots.get(item.id) as any)
            : item,
        );
        const historicMemo = new WeakMap<Resource, boolean>();
        for (const scope of scopes) {
          const current = all.find((item) => item.id === scope.id);
          if (
            !current ||
            current.deleted_at ||
            !canRead(current, userId, role, all, new Set(visited), memo) ||
            !canRead(
              scopeResource(scope),
              userId,
              role,
              historic,
              new Set(visited),
              historicMemo,
            )
          )
            return false;
        }
      }
    }
    if (resource.kind === "dashboard") {
      const scopes = resource.data.dashboardScopes || [];
      const historic = all.map((r) => {
        const scope = scopes.find((s: any) => s.id === r.id);
        return scope ? scopeResource(scope) : r;
      });
      for (const scope of scopes) {
        const current = all.find((r) => r.id === scope.id);
        if (
          !current ||
          current.deleted_at ||
          !canRead(current, userId, role, all, new Set(visited), memo) ||
          !canRead(
            scopeResource(scope),
            userId,
            role,
            historic,
            new Set(visited),
          )
        )
          return false;
      }
      const ids = resource.data.dashboardConfig?.projectIds || [];
      for (const id of ids) {
        const project = all.find(
          (r) => r.id === id && r.kind === "project" && !r.deleted_at,
        );
        if (
          !project ||
          !canRead(project, userId, role, all, new Set(visited), memo)
        )
          return false;
      }
      if (role === "guest")
        return resource.created_by === userId || ids.length > 0;
    }
    if (resource.kind === "notification" && resource.data.assigneeId !== userId)
      return false;
    if (isDelivery(resource)) {
      for (const id of deliveryIds(resource)) {
        const scope = all.find((r) => r.id === id);
        if (
          !scope ||
          !canRead(scope, userId, role, all, new Set(visited), memo)
        )
          return false;
      }
      for (const scope of resource.data.deliveryReceipt?.scopes || []) {
        const current = all.find((r) => r.id === scope.id);
        if (
          !current ||
          !canRead(current, userId, role, all, new Set(visited), memo) ||
          !canRead(
            scopeResource(scope),
            userId,
            role,
            all,
            new Set(visited),
            memo,
          )
        )
          return false;
      }
    }
    if (resource.kind === "view" && resource.data.viewConfig) {
      for (const id of [
        ...(resource.data.viewConfig.projectIds || []),
        ...(resource.data.viewConfig.fieldFilters || []).map(
          (f: any) => f.projectId,
        ),
        ...(resource.data.viewConfig.fieldColumns || []).map(
          (f: any) => f.projectId,
        ),
        ...(resource.data.viewConfig.sprintIds || []),
      ]) {
        const scope = all.find((r) => r.id === id);
        if (
          !scope ||
          !canRead(scope, userId, role, all, new Set(visited), memo)
        )
          return false;
      }
    }
    if (resource.kind === "template")
      for (const scope of resource.data.templateScopes || []) {
        const current = all.find((r) => r.id === scope.id);
        if (
          !current ||
          !canRead(current, userId, role, all, new Set(visited), memo) ||
          !canRead(
            scopeResource(scope),
            userId,
            role,
            all,
            new Set(visited),
            memo,
          )
        )
          return false;
      }
    for (const field of ["targetId", "parentId"]) {
      if (resource.data[field]) {
        const parent = all.find((r) => r.id === resource.data[field]);
        if (
          !parent ||
          (parent.deleted_at && !resource.deleted_at) ||
          !canRead(parent, userId, role, all, new Set(visited), memo)
        )
          return false;
      }
    }
    const project =
      resource.kind === "project"
        ? resource
        : all.find(
            (r) => r.id === resource.data.projectId && r.kind === "project",
          );
    if (resource.kind !== "project" && resource.data.projectId && !project)
      return false;
    if (
      project &&
      project.id !== resource.id &&
      !canRead(project, userId, role, all, new Set(visited), memo)
    )
      return false;
    if (project && project.deleted_at && !resource.deleted_at) return false;
    if (project?.data.private || role === "guest") {
      if (role === "admin" && !resource.data.ownerId) return true;
      if (!project) return resource.created_by === userId;
      return (
        project.created_by === userId ||
        (project.data.members || []).includes(userId)
      );
    }
    return true;
  }
}
