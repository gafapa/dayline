import { api, send } from "./api";
import { clearLocalUser, forgetSession, localLogoutIssue } from "./storage";
import { localSessionIssue, sessionEpoch } from "./local-lifecycle";

/** Sign-out was refused because this device still holds unsent work. */
export class LocalWorkRetained extends Error {}

let active:
  | { userId: string; initialEpoch: string; ended: () => void }
  | undefined;

/**
 * Signs this device out. Refuses while this tab has work in progress, or while the device
 * still holds unsent changes, drafts or unconfirmed documents, unless `preserveLocal` keeps
 * them. Other tabs notice through the storage event and return to sign-in.
 */
export async function signOutEverywhereLocal(preserveLocal = false) {
  if (!active) throw new Error("Espera a que cargue la sesión.");
  const { userId, initialEpoch, ended } = active;
  const open = localSessionIssue();
  if (open) throw new Error(open);
  if (!preserveLocal) {
    const issue = await localLogoutIssue(userId);
    if (issue) throw new LocalWorkRetained(issue);
  }
  await api("/logout", { ...send({}), signal: AbortSignal.timeout(8000) });
  // Written before deleting anything so a sleeping tab also sees the sign-out on wake.
  const epoch = crypto.randomUUID();
  localStorage.setItem("kelvin-auth-generation", epoch);
  localStorage.setItem(`kelvin-signout:${userId}`, epoch);
  ended();
  await forgetSession(userId, initialEpoch);
  if (!preserveLocal) await clearLocalUser(userId);
}

/** Watches for a sign-out from another tab; returns the cleanup. */
export function coordinateLocalSession(userId: string, ended: () => void) {
  const entry = { userId, initialEpoch: sessionEpoch(userId), ended };
  active = entry;
  const storage = (event: StorageEvent) => {
    if (
      event.key === `kelvin-signout:${userId}` &&
      event.newValue &&
      event.newValue !== entry.initialEpoch
    )
      ended();
  };
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener("storage", storage);
    if (active === entry) active = undefined;
  };
}
