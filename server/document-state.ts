import * as Y from "yjs";
import { validateDocumentContent } from "./document-validation.js";
import {
  DOCUMENT_SCHEMA_MESSAGE,
  compatibleDocumentSchema,
} from "../shared/document-protocol.js";
import { HttpError } from "./errors.js";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { documentExtensions } from "../shared/editor-schema.js";
import type { Database } from "./database.js";
const schema = getSchema(documentExtensions());
export async function documentState(db: Database, id: string): Promise<Buffer> {
  return db.transaction(async (tx) => {
    const row = (
      await tx.query("SELECT data FROM resources WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!row) throw new Error("Document unavailable");
    if (!compatibleDocumentSchema(row.data.documentSchemaVersion ?? 1))
      throw new HttpError(409, DOCUMENT_SCHEMA_MESSAGE, {
        code: "document_schema_mismatch",
      });
    const previous = (
      await tx.query("SELECT state FROM document_states WHERE resource_id=$1", [
        id,
      ])
    ).rows[0]?.state;
    if (previous) return Buffer.from(previous);
    if (row.data.documentSeedVersion !== undefined)
      throw new HttpError(
        409,
        "No se ha podido recuperar el estado inicial del documento. El contenido se conserva para revisión.",
        { code: "initial_document_state_unavailable" },
      );
    if (row.data.content !== undefined && row.data.content !== null)
      validateDocumentContent(row.data.content);
    const document = prosemirrorJSONToYDoc(
      schema,
      row.data.content || { type: "doc", content: [{ type: "paragraph" }] },
      "default",
    );
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    document.destroy();
    await tx.query(
      "INSERT INTO document_states(resource_id,state) VALUES($1,$2)",
      [id, state],
    );
    return state;
  });
}
