import { openDB } from "idb";
import { openLocalDatabase, deleteLocalDatabase } from "./local-database";
import { assertLocalSession, sessionEpoch } from "./local-lifecycle";
import type { Mutation, Resource, Workspace } from "../shared/model";
import { api, ApiError, send } from "./api";
interface Pending {
  key: string;
  workspaceId: string;
  mutation: Mutation;
  resource: Resource;
  error?: string;
  current?: Resource | null;
  sequence?: number;
}
const connections = new Map<string, ReturnType<typeof openDB>>();
const databaseConnection = (userId: string) => {
  let connection = connections.get(userId);
  if (!connection) {
    connection = openLocalDatabase(`kelvin-${userId}`, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("snapshots"))
          db.createObjectStore("snapshots");
        if (!db.objectStoreNames.contains("outbox"))
          db.createObjectStore("outbox", { keyPath: "key" });
        if (!db.objectStoreNames.contains("metadata"))
          db.createObjectStore("metadata").put(Date.now() * 1000, "sequence");
      },
      blocking() {
        void connection?.then((db) => db.close());
        connections.delete(userId);
      },
    });
    connections.set(userId, connection);
    void connection.catch(() => {
      if (connections.get(userId) === connection) connections.delete(userId);
    });
  }
  return connection;
};
const database = async (userId: string) => {
  assertLocalSession(userId, true);
  const db = await databaseConnection(userId);
  assertLocalSession(userId, true);
  return db;
};
const sessionDatabase = () =>
  openLocalDatabase("kelvin-session", 1, {
    upgrade(db) {
      db.createObjectStore("context");
    },
  });
export async function rememberSession(value: any) {
  const generation = localStorage.getItem("kelvin-auth-generation");
  const db = await sessionDatabase();
  if (generation !== localStorage.getItem("kelvin-auth-generation")) {
    db.close();
    return;
  }
  assertLocalSession(value.user.id);
  await db.put(
    "context",
    { ...value, localSessionEpoch: sessionEpoch(value.user.id) },
    "current",
  );
  db.close();
}
export async function rememberedSession() {
  const db = await sessionDatabase();
  const value = await db.get("context", "current");
  db.close();
  return value &&
    (value.localSessionEpoch || "") === sessionEpoch(value.user.id)
    ? value
    : undefined;
}
export async function forgetSession(userId?: string, epoch?: string) {
  const db = await sessionDatabase();
  const tx = db.transaction("context", "readwrite");
  const current = await tx.store.get("current");
  if (
    !userId ||
    (current?.user?.id === userId &&
      (current.localSessionEpoch || "") === epoch)
  )
    await tx.store.delete("current");
  await tx.done;
  db.close();
}
export async function localSnapshot(userId: string, workspaceId: string) {
  const db = await database(userId);
  return (await db.get("snapshots", workspaceId)) as
    | { resources: Resource[]; members: any[]; workspace?: Workspace }
    | undefined;
}
export async function pendingOperations(
  userId: string,
  workspaceId: string,
): Promise<Pending[]> {
  const db = await database(userId);
  return (await db.getAll("outbox"))
    .filter((p) => p.workspaceId === workspaceId)
    .sort(
      (a: Pending, b: Pending) =>
        (a.sequence || Number(a.key.split("-")[0]) * 1000) -
        (b.sequence || Number(b.key.split("-")[0]) * 1000),
    );
}
export async function cacheSnapshot(
  userId: string,
  workspaceId: string,
  snapshot: any,
  readSequence?: number,
) {
  const db = await database(userId);
  const sequence =
    readSequence ?? (await beginSnapshotRead(userId, workspaceId));
  assertLocalSession(userId);
  const tx = db.transaction(["snapshots", "metadata"], "readwrite"),
    metadata = tx.objectStore("metadata");
  const committed = Number(
    (await metadata.get(`snapshot-committed:${workspaceId}`)) || 0,
  );
  if (sequence < committed) {
    await tx.done;
    return false;
  }
  await tx.objectStore("snapshots").put(snapshot, workspaceId);
  await metadata.put(sequence, `snapshot-committed:${workspaceId}`);
  await tx.done;
  return true;
}
export async function beginSnapshotRead(userId: string, workspaceId: string) {
  const db = await database(userId);
  assertLocalSession(userId);
  const tx = db.transaction("metadata", "readwrite"),
    key = `snapshot-issued:${workspaceId}`;
  const next = Number((await tx.store.get(key)) || 0) + 1;
  await tx.store.put(next, key);
  await tx.done;
  return next;
}
export async function queueMutation(
  userId: string,
  workspaceId: string,
  resource: Resource,
  expectedVersion: number,
) {
  const db = await database(userId);
  assertLocalSession(userId);
  const operationId = crypto.randomUUID();
  const mutation: Mutation = {
    operationId,
    id: resource.id,
    kind: resource.kind,
    title: resource.title,
    data: resource.data,
    expectedVersion,
    deleted: !!resource.deleted_at,
  };
  const transaction = db.transaction(["outbox", "metadata"], "readwrite");
  const sequence =
    Number(
      (await transaction.objectStore("metadata").get("sequence")) ||
        Date.now() * 1000,
    ) + 1;
  await transaction.objectStore("metadata").put(sequence, "sequence");
  await transaction.objectStore("outbox").put({
    key: `${Date.now()}-${operationId}`,
    workspaceId,
    mutation,
    resource,
    sequence,
  });
  await transaction.done;
}
const active = new Map<string, Promise<void>>();
export function flushOutbox(
  userId: string,
  workspaceId: string,
  onChange: () => void,
): Promise<void> {
  const key = `${userId}:${workspaceId}`;
  if (active.has(key)) return active.get(key)!;
  const run = async () => {
    const db = await database(userId);
    const blocked = new Set<string>();
    while (true) {
      const pending = await pendingOperations(userId, workspaceId);
      for (const item of pending) if (item.error) blocked.add(item.resource.id);
      const item = pending.find((p) => !p.error && !blocked.has(p.resource.id));
      if (!item) break;
      try {
        const result = await api<{ resource: Resource }>(
          `/workspaces/${workspaceId}/mutate`,
          send(item.mutation),
        );
        const transaction = db.transaction(
          ["outbox", "snapshots", "metadata"],
          "readwrite",
        );
        await transaction.objectStore("outbox").delete(item.key);
        const snapshot = (await transaction
          .objectStore("snapshots")
          .get(workspaceId)) || {
          resources: [],
          members: [],
        };
        snapshot.resources = [
          result.resource,
          ...snapshot.resources.filter(
            (r: Resource) => r.id !== result.resource.id,
          ),
        ];
        await transaction.objectStore("snapshots").put(snapshot, workspaceId);
        const metadata = transaction.objectStore("metadata"),
          barrier =
            Number(
              (await metadata.get(`snapshot-issued:${workspaceId}`)) || 0,
            ) + 1;
        await metadata.put(barrier, `snapshot-issued:${workspaceId}`);
        await metadata.put(barrier, `snapshot-committed:${workspaceId}`);
        await transaction.done;
        onChange();
      } catch (error) {
        if (
          error instanceof ApiError &&
          [400, 403, 404, 409].includes(error.status)
        ) {
          await db.put("outbox", {
            ...item,
            error: error.message,
            current: error.detail?.current,
          });
          blocked.add(item.resource.id);
          onChange();
        } else throw error;
      }
    }
  };
  const work = (
    navigator.locks
      ? navigator.locks.request(`kelvin-outbox-${key}`, run)
      : run()
  ).finally(() => active.delete(key));
  active.set(key, work);
  return work;
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    for (const connection of connections.values())
      void connection.then((db) => db.close());
    connections.clear();
  });
export async function resolveConflict(
  userId: string,
  key: string,
  keepLocal: boolean,
) {
  const db = await database(userId);
  assertLocalSession(userId);
  const item: Pending = await db.get("outbox", key);
  assertLocalSession(userId);
  if (!item) return;
  if (!keepLocal) {
    for (const p of await pendingOperations(userId, item.workspaceId))
      if (p.resource.id === item.resource.id) await db.delete("outbox", p.key);
    return;
  }
  if (!item.current)
    throw new Error(
      "Este cambio requiere revisar sus permisos o sus relaciones. El borrador se conserva.",
    );
  item.mutation.expectedVersion = item.current.version;
  item.mutation.operationId = crypto.randomUUID();
  delete item.error;
  delete item.current;
  await db.put("outbox", item);
}
export async function clearLocalUser(userId: string) {
  const db = await connections.get(userId);
  db?.close();
  connections.delete(userId);
  await deleteLocalDatabase(`kelvin-${userId}`);
  if (indexedDB.databases)
    for (const entry of await indexedDB.databases())
      if (entry.name?.startsWith(`kelvin-${userId}-document-`))
        await deleteLocalDatabase(entry.name);
}
export async function readUserDraft(userId: string, key: string) {
  return (await database(userId)).get("metadata", "draft:" + key);
}
export async function writeUserDraft(
  userId: string,
  key: string,
  value: unknown,
  protect = false,
) {
  const db = await database(userId);
  assertLocalSession(userId);
  const tx = db.transaction("metadata", "readwrite");
  await tx.store.put(value, "draft:" + key);
  if (protect || key.includes(":command:"))
    await tx.store.put(true, "protected-draft:" + key);
  await tx.done;
}
export async function removeUserDraft(userId: string, key: string) {
  const db = await database(userId);
  assertLocalSession(userId);
  const tx = db.transaction("metadata", "readwrite");
  await tx.store.delete("draft:" + key);
  await tx.store.delete("protected-draft:" + key);
  await tx.done;
}
// Check every workspace, including pending operations outside the current screen.
export async function localLogoutIssue(userId: string) {
  const db = await databaseConnection(userId);
  if (await db.count("outbox"))
    return "Hay cambios pendientes de sincronizar en este dispositivo.";
  const keys = await db.getAllKeys("metadata");
  if (
    keys.some((key) => {
      const name = String(key);
      return (
        name.startsWith("protected-draft:") ||
        (name.startsWith("draft:") &&
          !name.startsWith("draft:navigation-denied:") &&
          !/^draft:[a-f0-9-]+:analytics:/.test(name) &&
          !/^draft:[a-f0-9-]+:reminder-status-cache$/.test(name) &&
          !name.endsWith(":planning-cache") &&
          !name.endsWith(":review-cache"))
      );
    })
  )
    return "Hay borradores o comandos sin confirmar. Guárdalos o descártalos desde su pantalla antes de cerrar sesión.";
  if (!indexedDB.databases)
    return "Este navegador no permite comprobar todas las copias locales. Utiliza un navegador actualizado para cerrar la sesión de forma segura.";
  for (const entry of await indexedDB.databases()) {
    if (!entry.name?.startsWith(`kelvin-${userId}-document-`)) continue;
    const document = await openLocalDatabase(entry.name, 1);
    try {
      if (
        document.objectStoreNames.contains("custom") &&
        (await document.get("custom", "unsynced")) !== 0
      )
        return "Hay un documento sin confirmar en el servidor. Ábrelo y sincronízalo antes de cerrar sesión.";
    } finally {
      document.close();
    }
  }
  return "";
}
