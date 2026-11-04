import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { documentExtensions } from "./editor-schema.js";
const schema = getSchema(documentExtensions());

export function documentDurabilityPayload(document: Y.Doc, content?: unknown) {
  // Delete-only changes do not advance a Yjs state vector. Include visible content,
  // avoiding differences in garbage-collected binary tombstones between peers.
  return JSON.stringify([
    Array.from(Y.encodeStateVector(document)),
    content ??
      yXmlFragmentToProseMirrorRootNode(
        document.getXmlFragment("default"),
        schema,
      ).toJSON(),
  ]);
}
