import { z } from "zod";
export const appPages = [
  "overview",
  "my_tasks",
  "notes",
  "reminders",
  "projects",
  "tasks",
  "documents",
  "sprints",
  "calendar",
  "inbox",
  "team",
  "reports",
  "time",
  "settings",
  "trash",
  "activity",
  "ai",
  "planning",
  "templates",
  "workspaces",
  "platform",
] as const;
export type AppPage = (typeof appPages)[number];
const id = z.string().uuid(),
  page = z.enum(appPages);
export type AppRoute =
  | {
      type: "resource";
      id: string;
      backdrop?: {
        page: AppPage;
        projectId?: string;
        containerId?: string;
        dashboardId?: string;
      };
    }
  | {
      type: "page";
      page: AppPage;
      workspaceId?: string;
      projectId?: string;
      containerId?: string;
    }
  | { type: "invalid" };
export function readAppRoute(
  href: string,
  origin: string,
  state?: any,
): AppRoute | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !["/", "/index.html"].includes(url.pathname))
    return null;
  const values = url.searchParams.getAll("resource");
  if (values.length) {
    if (values.length !== 1 || !id.safeParse(values[0]).success)
      return { type: "invalid" };
    const backdrop = state?.kelvin?.backdrop;
    return {
      type: "resource",
      id: values[0].toLowerCase(),
      ...(page.safeParse(backdrop?.page).success
        ? {
            backdrop: {
              page: backdrop.page,
              ...(backdrop.page === "reports" &&
              id.safeParse(backdrop.dashboardId).success
                ? { dashboardId: backdrop.dashboardId }
                : {}),
              ...(id.safeParse(backdrop.containerId).success
                ? { containerId: backdrop.containerId }
                : {}),
              ...(id.safeParse(backdrop.projectId).success
                ? { projectId: backdrop.projectId }
                : {}),
            },
          }
        : {}),
    };
  }
  if (url.searchParams.has("invitation")) return null;
  const view = url.searchParams.get("view") || "overview",
    workspaceId = url.searchParams.get("workspace"),
    projectId = url.searchParams.get("project"),
    containerId = url.searchParams.get("location");
  if (
    !page.safeParse(view).success ||
    ["view", "workspace", "project", "location"].some(
      (key) => url.searchParams.getAll(key).length > 1,
    ) ||
    (containerId &&
      (view !== "projects" || !id.safeParse(containerId).success)) ||
    (workspaceId && !id.safeParse(workspaceId).success) ||
    (projectId && !id.safeParse(projectId).success)
  )
    return { type: "invalid" };
  return {
    type: "page",
    page: view as AppPage,
    ...(containerId ? { containerId: containerId.toLowerCase() } : {}),
    ...(workspaceId ? { workspaceId: workspaceId.toLowerCase() } : {}),
    ...(projectId ? { projectId: projectId.toLowerCase() } : {}),
  };
}
export function resourceHref(resourceId: string, origin: string) {
  return new URL(`/?resource=${id.parse(resourceId).toLowerCase()}`, origin)
    .href;
}
export function pageHref(
  view: AppPage,
  workspaceId?: string,
  projectId?: string,
  containerId?: string,
) {
  const query = new URLSearchParams();
  if (view !== "overview") query.set("view", page.parse(view));
  if (workspaceId) query.set("workspace", id.parse(workspaceId));
  if (projectId) query.set("project", id.parse(projectId));
  if (containerId) {
    if (view !== "projects")
      throw new Error("A structure location requires the projects page.");
    query.set("location", id.parse(containerId));
  }
  return "/" + (query.size ? "?" + query.toString() : "");
}
