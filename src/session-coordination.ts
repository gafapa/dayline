import { api, send } from "./api";
import { clearLocalUser, forgetSession, localLogoutIssue } from "./storage";
import {
  freezeLocalSession,
  localSessionIssue,
  sessionEpoch,
} from "./local-lifecycle";

export const SESSION_FREEZE_EVENT = "kelvin-session-freeze";
let isFrozen = false;
export const sessionIsFrozen = () => isFrozen;
export class LocalWorkRetained extends Error {}
let signOut: ((preserveLocal: boolean) => Promise<void>) | undefined;
export async function signOutEverywhereLocal(preserveLocal = false) {
  if (!navigator.locks?.query || !window.BroadcastChannel)
    throw new Error(
      "Este navegador no permite coordinar el cierre seguro entre pestañas. Utiliza una versión actual de Chrome, Edge, Firefox o Safari.",
    );
  if (!signOut)
    throw new Error("Espera a que se comprueben las pestañas abiertas.");
  await signOut(preserveLocal);
}

// The locks inventory includes suspended tabs; missing acknowledgements fail closed.
export function coordinateLocalSession(userId: string, ended: () => void) {
  if (!navigator.locks?.query || !window.BroadcastChannel) return () => {};
  const tabId = crypto.randomUUID(),
    prefix = `kelvin-tab:${userId}:`,
    lockName = prefix + tabId;
  const initialEpoch = sessionEpoch(userId);
  const channel = new BroadcastChannel(`kelvin-session:${userId}`);
  let ready = false,
    disposed = false,
    running = false,
    preparing = "",
    timer: ReturnType<typeof setTimeout>;
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  void navigator.locks.request(lockName, async () => {
    ready = true;
    await hold;
  });
  const freeze = (requestId: string) => {
    preparing = requestId;
    isFrozen = !!requestId;
    freezeLocalSession(isFrozen);
    window.dispatchEvent(new Event(SESSION_FREEZE_EVENT));
    clearTimeout(timer);
    if (requestId) timer = setTimeout(() => freeze(""), 20000);
  };
  const issue = async (preserveLocal: boolean) => {
    const open = localSessionIssue();
    if (open) return { message: open, retentionAllowed: false };
    const durable = preserveLocal ? "" : await localLogoutIssue(userId);
    return { message: durable, retentionAllowed: !!durable };
  };
  const replies = new Map<
    string,
    Map<string, { message: string; retentionAllowed: boolean }>
  >();
  const finish = () => {
    freeze("");
    ended();
  };
  channel.onmessage = async ({ data }) => {
    if (disposed || typeof data?.requestId !== "string") return;
    if (data.type === "prepare") {
      if (preparing && preparing !== data.requestId) {
        channel.postMessage({
          type: "ready",
          requestId: data.requestId,
          tabId,
          issue: "Otra pestaña está cerrando la sesión.",
        });
        return;
      }
      freeze(data.requestId);
      let reason: { message: string; retentionAllowed: boolean };
      try {
        reason = await issue(data.preserveLocal === true);
      } catch {
        reason = {
          message:
            "No se pudo comprobar la copia local. Los datos se conservan.",
          retentionAllowed: false,
        };
      }
      if (!disposed && preparing === data.requestId)
        channel.postMessage({
          type: "ready",
          requestId: data.requestId,
          tabId,
          issue: reason.message,
          retentionAllowed: reason.retentionAllowed,
        });
    } else if (
      data.type === "ready" &&
      typeof data.tabId === "string" &&
      typeof data.issue === "string"
    ) {
      replies
        .get(data.requestId)
        ?.set(prefix + data.tabId, {
          message: data.issue,
          retentionAllowed: data.retentionAllowed === true,
        });
    } else if (data.type === "cancel" && preparing === data.requestId)
      freeze("");
    else if (
      data.type === "commit" &&
      data.requestId === sessionEpoch(userId) &&
      data.requestId !== initialEpoch
    )
      finish();
  };
  const storage = (event: StorageEvent) => {
    if (
      event.key === `kelvin-signout:${userId}` &&
      event.newValue &&
      event.newValue !== initialEpoch
    )
      finish();
  };
  window.addEventListener("storage", storage);
  const execute = async (preserveLocal: boolean) => {
    if (!ready || disposed || preparing)
      throw new Error("Espera a que termine la comprobación de las pestañas.");
    const requestId = crypto.randomUUID(),
      received = new Map<
        string,
        { message: string; retentionAllowed: boolean }
      >();
    running = true;
    replies.set(requestId, received);
    freeze(requestId);
    try {
      const ownIssue = await issue(preserveLocal);
      if (ownIssue.message)
        throw ownIssue.retentionAllowed
          ? new LocalWorkRetained(ownIssue.message)
          : new Error(ownIssue.message);
      if (preparing !== requestId)
        throw new Error(
          "La comprobación ha caducado. Repite el cierre de sesión.",
        );
      const peers =
        (await navigator.locks.query()).held
          ?.filter(
            (lock) => lock.name?.startsWith(prefix) && lock.name !== lockName,
          )
          .map((lock) => lock.name!) || [];
      channel.postMessage({ type: "prepare", requestId, preserveLocal });
      const deadline = Date.now() + 3000;
      while (peers.some((peer) => !received.has(peer)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 40));
      if (peers.some((peer) => !received.has(peer)))
        throw new Error(
          "Otra pestaña no responde. Guarda sus cambios y ciérrala antes de cerrar sesión.",
        );
      const peerIssue = [...received.values()].find((value) => !!value.message);
      if (peerIssue)
        throw peerIssue.retentionAllowed
          ? new LocalWorkRetained("Otra pestaña: " + peerIssue.message)
          : new Error("Otra pestaña: " + peerIssue.message);
      const current =
        (await navigator.locks.query()).held?.filter(
          (lock) => lock.name?.startsWith(prefix) && lock.name !== lockName,
        ) || [];
      if (current.some((lock) => !received.has(lock.name!)))
        throw new Error(
          "Se ha abierto otra pestaña. Repite el cierre de sesión.",
        );
      if (preparing !== requestId)
        throw new Error(
          "La comprobación ha caducado. Repite el cierre de sesión.",
        );
      await api("/logout", { ...send({}), signal: AbortSignal.timeout(8000) });
      // Persist the fence before deleting anything, including for sleeping tabs.
      localStorage.setItem("kelvin-auth-generation", requestId);
      localStorage.setItem(`kelvin-signout:${userId}`, requestId);
      channel.postMessage({ type: "commit", requestId });
      finish();
      await forgetSession(userId, initialEpoch);
      if (!preserveLocal) await clearLocalUser(userId);
    } finally {
      channel.postMessage({ type: "cancel", requestId });
      replies.delete(requestId);
      freeze("");
      running = false;
      if (disposed) channel.close();
    }
  };
  const run = (preserveLocal: boolean) =>
    navigator.locks.request(
      `kelvin-session-gate:${userId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error(
            "Se está verificando otra sesión. Espera un momento y repite el cierre.",
          );
        await execute(preserveLocal);
      },
    );
  signOut = run;
  return () => {
    disposed = true;
    clearTimeout(timer);
    if (signOut === run) signOut = undefined;
    release();
    window.removeEventListener("storage", storage);
    if (!running) channel.close();
  };
}
