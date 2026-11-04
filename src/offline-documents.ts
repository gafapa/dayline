import * as Y from "yjs";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import { api } from "./api";
import { flushOutbox } from "./storage";
import type { Resource } from "../shared/model";
export async function downloadDocuments(
  userId: string,
  workspaceId: string,
  documents: Resource[],
  progress?: (count: number) => void,
) {
  await flushOutbox(userId, workspaceId, () => {});
  let count = 0;
  for (const resource of documents) {
    const { state } = await api(
      `/workspaces/${workspaceId}/documents/${resource.id}/state`,
    );
    const document = new Y.Doc(),
      persistence = new IndexeddbPersistence(
        `kelvin-${userId}-document-${resource.id}`,
        document,
      );
    try {
      await persistence.whenSynced;
      Y.applyUpdate(
        document,
        Uint8Array.from(atob(state), (c) => c.charCodeAt(0)),
      );
      await storeState(persistence, true);
      count += 1;
      progress?.(count);
    } finally {
      await persistence.destroy();
      document.destroy();
    }
  }
  return count;
}
