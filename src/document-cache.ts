import { openLocalDatabase } from "./local-database";
import {
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SCHEMA_MESSAGE,
  compatibleDocumentSchema,
} from "../shared/document-protocol";
// Read the marker before y-indexeddb can load or append any document updates.
export async function prepareDocumentCache(name: string) {
  const db = await openLocalDatabase(name, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("updates"))
        database.createObjectStore("updates", { autoIncrement: true });
      if (!database.objectStoreNames.contains("custom"))
        database.createObjectStore("custom");
    },
  });
  try {
    const tx = db.transaction("custom", "readwrite"),
      version = await tx.store.get("document-schema");
    // All unmarked releases used schema 1. A future migration must be explicit.
    if (version !== undefined && !compatibleDocumentSchema(version)) {
      await tx.done;
      throw new Error(DOCUMENT_SCHEMA_MESSAGE);
    }
    await tx.store.put(DOCUMENT_SCHEMA_VERSION, "document-schema");
    await tx.done;
  } finally {
    db.close();
  }
}
