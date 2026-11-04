import { resourceHref, readAppRoute, type AppPage } from "../shared/navigation";
export const navigationEvent = "kelvin:navigation";
export function requestResourceLink(href: string) {
  const route = readAppRoute(href, location.origin);
  if (route?.type !== "resource") return false;
  window.dispatchEvent(
    new CustomEvent(navigationEvent, {
      detail: { href: resourceHref(route.id, location.origin) },
    }),
  );
  return true;
}
export function localResourceLocation(
  id: string,
  page: AppPage,
  projectId?: string,
  containerId?: string,
  dashboardId?: string,
) {
  const href = resourceHref(id, location.origin);
  if (location.href !== href)
    history.pushState(
      { kelvin: { backdrop: { page, projectId, containerId, dashboardId } } },
      "",
      href,
    );
  window.dispatchEvent(
    new CustomEvent(navigationEvent, { detail: { handled: true } }),
  );
}
