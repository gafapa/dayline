import { openDB, deleteDB, type OpenDBCallbacks } from "idb";

export const LOCAL_DATABASE_EVENT = "kelvin-local-database";
export type LocalDatabaseIssue = "blocked" | "outdated";
const issues = new Map<string, LocalDatabaseIssue>();
const outdated = new Set<string>();
export function localDatabaseIssues() {
  return [...issues.values()];
}
function report(name: string, issue?: LocalDatabaseIssue) {
  if (issue) issues.set(name, issue);
  else issues.delete(name);
  window.dispatchEvent(new Event(LOCAL_DATABASE_EVENT));
}
export function openLocalDatabase(
  name: string,
  version: number,
  callbacks: OpenDBCallbacks<any> = {},
) {
  if (outdated.has(name))
    return Promise.reject(
      new Error(
        "Otra pestaña ha actualizado el almacenamiento. Conserva los cambios y actualiza esta pestaña.",
      ),
    );
  let connection: ReturnType<typeof openDB>;
  connection = openDB(name, version, {
    ...callbacks,
    blocked(...args) {
      report(name, "blocked");
      callbacks.blocked?.(...args);
    },
    blocking(...args) {
      if (args[1] !== null) {
        outdated.add(name);
        report(name, "outdated");
      }
      void connection.then((db) => db.close());
      callbacks.blocking?.(...args);
    },
    terminated() {
      outdated.add(name);
      report(name, "outdated");
      callbacks.terminated?.();
    },
  });
  return connection.then(
    (db) => {
      if (outdated.has(name)) {
        db.close();
        throw new Error(
          "Actualiza esta pestaña para abrir el almacenamiento local.",
        );
      }
      report(name);
      return db;
    },
    (error) => {
      if (error?.name === "VersionError") {
        outdated.add(name);
        report(name, "outdated");
      } else if (!outdated.has(name)) report(name);
      throw error;
    },
  );
}
export async function deleteLocalDatabase(name: string) {
  try {
    await deleteDB(name, { blocked: () => report(name, "blocked") });
  } finally {
    if (!outdated.has(name)) report(name);
  }
}
export function documentDatabaseChanged(name: string) {
  outdated.add(name);
  report(name, "outdated");
}
