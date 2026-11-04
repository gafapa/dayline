import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { documentExtensions } from "../shared/editor-schema";
import { documentDurabilityPayload } from "../shared/durability";

test("durability confirmation detects deletion-only changes and agrees across collected peers", () => {
  const document = prosemirrorJSONToYDoc(
    getSchema(documentExtensions()),
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Keep and delete" }],
        },
      ],
    },
    "default",
  );
  const beforeVector = Y.encodeStateVector(document),
    beforePayload = documentDurabilityPayload(document);
  const paragraph = document.getXmlFragment("default").get(0) as Y.XmlElement;
  (paragraph.get(0) as Y.XmlText).delete(4, 11);
  assert.deepEqual(Y.encodeStateVector(document), beforeVector);
  assert.notEqual(documentDurabilityPayload(document), beforePayload);
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(document));
  assert.equal(
    documentDurabilityPayload(replica),
    documentDurabilityPayload(document),
  );
  document.destroy();
  replica.destroy();
});
