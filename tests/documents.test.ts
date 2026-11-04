import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { documentExtensions } from "../shared/editor-schema";
import {
  documentHTML,
  documentMarkdown,
  documentHeadings,
  documentReferences,
  standaloneDocument,
} from "../shared/documents";

test("shared document schema retains tables, checklists and mathematics", () => {
  const schema = getSchema(documentExtensions());
  const document = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Acceptance" }],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Verified" }],
              },
            ],
          },
        ],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Result" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "inlineMath", attrs: { latex: "x^2" } }],
      },
    ],
  };
  const parsed = schema.nodeFromJSON(document).toJSON();
  assert.equal(parsed.content[1].type, "taskList");
  assert.equal(parsed.content[2].type, "table");
  assert.equal(parsed.content[3].content[0].attrs.latex, "x^2");
  assert.ok(documentMarkdown(parsed).includes("- [x] Verified"));
  assert.ok(documentMarkdown(parsed).includes("| Result |"));
  assert.ok(documentHTML(parsed).includes("<table>"));
  assert.deepEqual(documentHeadings(parsed), [
    { level: 2, text: "Acceptance" },
  ]);
});
test("HTML export escapes untrusted text and rejects executable links", () => {
  const node = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "<script>alert(1)</script>",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
    ],
  };
  const output = standaloneDocument("<img onerror=alert(1)>", node);
  assert.ok(!output.includes("<script>"));
  assert.ok(!output.includes('href="javascript:'));
  assert.ok(output.includes("&lt;script&gt;"));
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    documentReferences({
      type: "text",
      text: "Reference",
      marks: [{ type: "link", attrs: { href: "/?resource=" + id } }],
    }),
    [id],
  );
});
