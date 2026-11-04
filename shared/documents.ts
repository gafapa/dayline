export interface DocumentNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: DocumentNode[];
}
export const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function documentText(node?: DocumentNode): string {
  if (!node) return "";
  return (
    node.text ||
    node.attrs?.latex ||
    node.content
      ?.map(documentText)
      .join(node.type === "paragraph" ? "" : "\n") ||
    ""
  );
}
export function documentReferences(node?: DocumentNode): string[] {
  const result = new Set<string>();
  const visit = (n: DocumentNode) => {
    for (const mark of n.marks || []) {
      const href = mark.attrs?.href;
      if (typeof href === "string") {
        const match = /[?&]resource=([a-f\d-]{36})/i.exec(href);
        if (match) result.add(match[1]);
      }
    }
    for (const child of n.content || []) visit(child);
  };
  if (node) visit(node);
  return [...result];
}
export function documentHeadings(
  node?: DocumentNode,
): { level: number; text: string }[] {
  const result: { level: number; text: string }[] = [];
  const visit = (n: DocumentNode) => {
    if (n.type === "heading")
      result.push({
        level: Number(n.attrs?.level) || 2,
        text: documentText(n),
      });
    for (const child of n.content || []) visit(child);
  };
  if (node) visit(node);
  return result;
}
export function documentMarkdown(node?: DocumentNode, depth = 0): string {
  if (!node) return "";
  if (node.type === "text") {
    let value = node.text || "";
    for (const mark of node.marks || []) {
      if (mark.type === "bold") value = `**${value}**`;
      if (mark.type === "italic") value = `*${value}*`;
      if (mark.type === "strike") value = `~~${value}~~`;
      if (mark.type === "code") value = "`" + value + "`";
      if (mark.type === "link")
        value = `[${value}](${String(mark.attrs?.href || "").replace(/[\r\n()]/g, encodeURIComponent)})`;
    }
    return value;
  }
  const content = (node.content || [])
    .map((n) => documentMarkdown(n, depth + 1))
    .join("");
  switch (node.type) {
    case "doc":
      return content.trim() + "\n";
    case "paragraph":
      return content + "\n\n";
    case "heading":
      return (
        "#".repeat(Math.min(6, Math.max(1, node.attrs?.level || 2))) +
        " " +
        content +
        "\n\n"
      );
    case "bulletList":
    case "orderedList":
    case "taskList":
      return (
        (node.content || [])
          .map(
            (n, i) =>
              `${node.type === "orderedList" ? `${i + 1}. ` : node.type === "taskList" ? `- [${n.attrs?.checked ? "x" : " "}] ` : "- "}${documentMarkdown(
                n,
                depth + 1,
              )
                .trim()
                .replace(/\n/g, "\n  ")}\n`,
          )
          .join("") + "\n"
      );
    case "listItem":
    case "taskItem":
      return content;
    case "blockquote":
      return (
        content
          .trim()
          .split("\n")
          .map((line) => "> " + line)
          .join("\n") + "\n\n"
      );
    case "codeBlock":
      return (
        "```" +
        (node.attrs?.language || "") +
        "\n" +
        documentText(node) +
        "\n```\n\n"
      );
    case "horizontalRule":
      return "---\n\n";
    case "hardBreak":
      return "  \n";
    case "image":
      return `![${String(node.attrs?.alt || "").replace(/\]/g, "\\]")}](${node.attrs?.src || ""})\n\n`;
    case "inlineMath":
      return "$" + (node.attrs?.latex || "") + "$";
    case "blockMath":
      return "$$\n" + (node.attrs?.latex || "") + "\n$$\n\n";
    case "table": {
      const rows = (node.content || []).map((row) =>
        (row.content || []).map((cell) =>
          documentText(cell).replace(/\|/g, "\\|").replace(/\n/g, " "),
        ),
      );
      return (
        rows
          .map(
            (row, i) =>
              "| " +
              row.join(" | ") +
              " |\n" +
              (i === 0 ? "| " + row.map(() => "---").join(" | ") + " |\n" : ""),
          )
          .join("") + "\n"
      );
    }
    default:
      return content;
  }
}
function safeURL(value: unknown, image = false) {
  if (typeof value !== "string") return "";
  if (image)
    return value.startsWith("/api/") ||
      /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)
      ? value
      : "";
  return /^(https?:\/\/|mailto:|\/[^/]|#)/i.test(value) ? value : "";
}
export function documentHTML(node?: DocumentNode): string {
  if (!node) return "";
  if (node.type === "text") {
    let result = escapeHTML(node.text || "");
    for (const mark of node.marks || []) {
      const tags: Record<string, string> = {
        bold: "strong",
        italic: "em",
        strike: "s",
        code: "code",
        underline: "u",
      };
      if (tags[mark.type])
        result = `<${tags[mark.type]}>${result}</${tags[mark.type]}>`;
      if (mark.type === "link") {
        const href = safeURL(mark.attrs?.href);
        if (href)
          result = `<a href="${escapeHTML(href)}" rel="noopener noreferrer">${result}</a>`;
      }
    }
    return result;
  }
  const body = (node.content || []).map(documentHTML).join("");
  const tags: Record<string, string> = {
    paragraph: "p",
    bulletList: "ul",
    orderedList: "ol",
    listItem: "li",
    taskList: "ul",
    taskItem: "li",
    blockquote: "blockquote",
    table: "table",
    tableRow: "tr",
    tableCell: "td",
    tableHeader: "th",
  };
  if (tags[node.type])
    return `<${tags[node.type]}>${node.type === "taskItem" ? (node.attrs?.checked ? "☑ " : "☐ ") : ""}${body}</${tags[node.type]}>`;
  if (node.type === "heading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 2));
    return `<h${level}>${body}</h${level}>`;
  }
  if (node.type === "codeBlock")
    return `<pre><code>${escapeHTML(documentText(node))}</code></pre>`;
  if (node.type === "horizontalRule") return "<hr>";
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "image") {
    const src = safeURL(node.attrs?.src, true);
    return src
      ? `<img src="${escapeHTML(src)}" alt="${escapeHTML(node.attrs?.alt || "")}">`
      : "";
  }
  if (node.type === "inlineMath" || node.type === "blockMath")
    return `<${node.type === "blockMath" ? "p" : "span"} class="math">${escapeHTML(node.attrs?.latex || "")}</${node.type === "blockMath" ? "p" : "span"}>`;
  return body;
}
export function standaloneDocument(title: string, content: DocumentNode) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:850px;margin:48px auto;padding:0 24px;color:#222}h1,h2,h3{line-height:1.3}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px;text-align:left}pre{white-space:pre-wrap;background:#f4f4f4;padding:16px}blockquote{border-left:3px solid #aaa;padding-left:18px;margin-left:0}img{max-width:100%}@media print{body{max-width:none;margin:0}@page{margin:20mm}h1,h2,h3{break-after:avoid}tr{break-inside:avoid}}</style><h1>${escapeHTML(title)}</h1>${documentHTML(content)}</html>`;
}
