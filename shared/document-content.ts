import type { Schema } from "@tiptap/pm/model";
export function assertDocumentContent(
  documentSchema: Schema,
  content: unknown,
) {
  let count = 0;
  const visit = (node: any, depth: number) => {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      depth > 64 ||
      ++count > 20000
    )
      throw new Error("Invalid document tree");
    const type = documentSchema.nodes[node.type];
    if (!type) throw new Error("Unknown node");
    for (const attribute of Object.keys(node.attrs || {}))
      if (!Object.hasOwn(type.spec.attrs || {}, attribute))
        throw new Error("Unknown node attribute");
    for (const mark of node.marks || []) {
      const type = documentSchema.marks[mark.type];
      if (!type) throw new Error("Unknown mark");
      for (const attribute of Object.keys(mark.attrs || {}))
        if (!Object.hasOwn(type.spec.attrs || {}, attribute))
          throw new Error("Unknown mark attribute");
    }
    for (const child of node.content || []) visit(child, depth + 1);
  };
  visit(content, 0);
  documentSchema.nodeFromJSON(content).check();
}
