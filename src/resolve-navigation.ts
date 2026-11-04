import { api, ApiError } from "./api";
import {
  cacheSnapshot,
  beginSnapshotRead,
  localSnapshot,
  pendingOperations,
  flushOutbox,
  readUserDraft,
  writeUserDraft,
  removeUserDraft,
} from "./storage";
import type { Resource, Workspace } from "../shared/model";
import type { AppRoute } from "../shared/navigation";
type Snapshot = {
  resources: Resource[];
  members: any[];
  workspace?: Workspace;
};
export type NavigationResult = {
  workspace: Workspace;
  snapshot: Snapshot;
  resource?: Resource;
  offline: boolean;
};
const overlay = async (
  userId: string,
  workspaceId: string,
  snapshot: Snapshot,
) => {
  const queued = await pendingOperations(userId, workspaceId),
    resources = new Map(snapshot.resources.map((r) => [r.id, r]));
  for (const item of queued) resources.set(item.resource.id, item.resource);
  return { ...snapshot, resources: [...resources.values()] };
};
async function cachedResource(
  userId: string,
  workspaces: Workspace[],
  resourceId: string,
) {
  if (await readUserDraft(userId, `navigation-denied:${resourceId}`))
    throw new Error(
      "El último control de acceso rechazó este enlace. Conéctate para verificarlo de nuevo.",
    );
  const matches = (
    await Promise.all(
      workspaces.map(async (workspace) => {
        const cached = await localSnapshot(userId, workspace.id);
        const snapshot = await overlay(
          userId,
          workspace.id,
          cached || { resources: [], members: [] },
        );
        const resource = snapshot.resources.find(
          (r) => r.id === resourceId && !r.deleted_at,
        );
        return resource
          ? {
              workspace: snapshot.workspace || workspace,
              snapshot,
              resource,
              offline: true,
            }
          : null;
      }),
    )
  ).filter(Boolean);
  if (matches.length !== 1)
    throw new Error(
      "Este elemento no está descargado en el dispositivo. Conéctate para abrirlo.",
    );
  return matches[0]!;
}
export async function resolveNavigation(
  userId: string,
  workspaces: Workspace[],
  currentWorkspaceId: string,
  route: Exclude<AppRoute, { type: "invalid" }>,
  signal: AbortSignal,
  stillCurrent: () => boolean,
): Promise<NavigationResult> {
  const cached = async () => {
    if (route.type === "resource")
      return cachedResource(userId, workspaces, route.id);
    const workspace =
      workspaces.find(
        (w) => w.id === (route.workspaceId || currentWorkspaceId),
      ) || (!route.workspaceId ? workspaces[0] : undefined);
    if (!workspace)
      throw new Error("Este espacio no está disponible para esta cuenta.");
    const snapshot = await localSnapshot(userId, workspace.id);
    if (!snapshot)
      throw new Error(
        "Este espacio aún no está descargado. Conéctate para abrirlo.",
      );
    return {
      workspace: snapshot.workspace || workspace,
      snapshot: await overlay(userId, workspace.id, snapshot),
      offline: true,
    };
  };
  if (!navigator.onLine) return cached();
  try {
    let workspace: Workspace | undefined;
    if (route.type === "resource") {
      try {
        workspace = (await api(`/resources/${route.id}/location`, { signal }))
          .workspace;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        const pending = await Promise.all(
          workspaces.map(async (w) => ({
            workspace: w,
            items: await pendingOperations(userId, w.id),
          })),
        );
        const local = pending.find((entry) =>
          entry.items.some(
            (item) =>
              item.resource.id === route.id &&
              item.mutation.expectedVersion === 0,
          ),
        );
        if (!local) throw error;
        await flushOutbox(userId, local.workspace.id, () => {});
        workspace = (await api(`/resources/${route.id}/location`, { signal }))
          .workspace;
      }
    } else
      workspace =
        workspaces.find(
          (w) => w.id === (route.workspaceId || currentWorkspaceId),
        ) || (!route.workspaceId ? workspaces[0] : undefined);
    if (!workspace)
      throw new Error("Este espacio no está disponible para esta cuenta.");
    const readSequence = await beginSnapshotRead(userId, workspace.id);
    let snapshot: Snapshot = await api(
      `/workspaces/${workspace.id}/resources`,
      { signal },
    );
    if (!stillCurrent() || signal.aborted)
      throw new DOMException("Navigation superseded", "AbortError");
    if (!(await cacheSnapshot(userId, workspace.id, snapshot, readSequence)))
      snapshot = (await localSnapshot(userId, workspace.id)) || snapshot;
    const resource =
      route.type === "resource"
        ? snapshot.resources.find((r) => r.id === route.id && !r.deleted_at)
        : undefined;
    if (route.type === "resource" && !resource)
      throw new ApiError(
        404,
        "El enlace ya no está disponible para esta cuenta.",
      );
    const displayed = await overlay(userId, workspace.id, snapshot);
    if (route.type === "resource")
      await removeUserDraft(userId, `navigation-denied:${route.id}`);
    return {
      workspace: snapshot.workspace || workspace,
      snapshot: displayed,
      resource: resource
        ? displayed.resources.find((r) => r.id === resource.id)
        : undefined,
      offline: false,
    };
  } catch (error) {
    if (
      route.type === "resource" &&
      stillCurrent() &&
      !signal.aborted &&
      error instanceof ApiError &&
      [403, 404].includes(error.status)
    )
      await writeUserDraft(userId, `navigation-denied:${route.id}`, {
        at: Date.now(),
      });
    if (
      signal.aborted ||
      !stillCurrent() ||
      error instanceof ApiError ||
      !(error instanceof TypeError)
    )
      throw error;
    return cached();
  }
}
