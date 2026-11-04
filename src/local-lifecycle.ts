// Shared by storage, network requests and the cross-tab session coordinator.
const guards = new Set<() => string>();
let frozen = false;
let requests = 0;
export const sessionEpoch = (userId: string) =>
  localStorage.getItem(`kelvin-signout:${userId}`) || "";
const epochs = new Map<string, string>();
export function authorizeLocalUser(userId: string) {
  epochs.set(userId, sessionEpoch(userId));
  frozen = false;
}
export function withLocalSessionGate<T>(
  userId: string,
  work: () => Promise<T>,
) {
  return navigator.locks
    ? navigator.locks.request(
        `kelvin-session-gate:${userId}`,
        { mode: "shared" },
        work,
      )
    : work();
}
export function freezeLocalSession(value: boolean) {
  frozen = value;
}
export function assertLocalSession(userId?: string, allowFrozen = false) {
  if (
    (frozen && !allowFrozen) ||
    (userId &&
      epochs.has(userId) &&
      epochs.get(userId) !== sessionEpoch(userId))
  )
    throw new Error(
      "La sesión se está cerrando. Los cambios locales se conservan.",
    );
}
export function trackRequest() {
  requests++;
  return () => {
    requests--;
  };
}
export function registerLocalGuard(guard: () => string) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
export function localSessionIssue() {
  if (requests) return "Hay solicitudes pendientes. Espera a que terminen.";
  for (const guard of guards) {
    const issue = guard();
    if (issue) return issue;
  }
  return "";
}
