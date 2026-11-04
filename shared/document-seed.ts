import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { documentExtensions } from "./editor-schema.js";
import { assertDocumentContent } from "./document-content.js";
export { DOCUMENT_SEED_VERSION } from "./document-protocol.js";

const schema = getSchema(documentExtensions());
export function initialDocument(content: unknown, resourceId: string) {
  assertDocumentContent(schema, content);
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      resourceId,
    )
  )
    throw new Error("Invalid document identifier");
  const document = new Y.Doc();
  // Version 1 reserves this document-specific client ID for its immutable initial seed.
  // Apply the encoded seed to a separate random-ID document before making local edits.
  document.clientID = Number.parseInt(resourceId.slice(0, 8), 16) >>> 0;
  prosemirrorToYXmlFragment(
    schema.nodeFromJSON(content),
    document.getXmlFragment("default"),
  );
  return document;
}
