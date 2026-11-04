import { fieldFilterError, type FieldFilter } from "../shared/custom-fields.js";
import { validateDocumentContent } from "./document-validation.js";
import { isDeepStrictEqual } from "node:util";
import { getSchema } from "@tiptap/core";
import { documentExtensions } from "../shared/editor-schema.js";
import {
  resourceDataSchema,
  type Resource,
  type Role,
} from "../shared/model.js";
import {
  templateBlueprintSchema,
  taskViewSchema,
  rewriteDocument,
} from "../shared/collections.js";
import { validTimeZone } from "../shared/automation.js";
import { canRead } from "./permissions.js";
import { acceptsChild } from "../shared/hierarchy.js";
import { HttpError } from "./errors.js";
import type { Connection } from "./database.js";
export const templateFields = new Set([
  "description",
  "content",
  "documentSchemaVersion",
  "personalNote",
  "goal",
  "acceptance",
  "definitionOfDone",
  "priority",
  "taskType",
  "labels",
  "estimate",
  "checklist",
  "customFields",
  "fieldDefinitions",
  "fieldSnapshots",
  "workflowStates",
  "stateId",
  "private",
  "order",
]);
const schema = getSchema(documentExtensions());
export function validateBlueprint(value: unknown) {
  const blueprint = templateBlueprintSchema.parse(value),
    nodes = new Map(blueprint.nodes.map((node) => [node.key, node]));
  if (nodes.size !== blueprint.nodes.length || !nodes.has(blueprint.rootKey))
    throw new HttpError(
      400,
      "La plantilla necesita una raíz y claves de elementos únicas.",
    );
  const root = nodes.get(blueprint.rootKey)!;
  if (root.kind === "folder")
    throw new HttpError(
      400,
      "Captura la carpeta dentro de una plantilla de proyecto.",
    );
  if (root.parentKey || root.projectKey)
    throw new HttpError(
      400,
      "La raíz de la plantilla no puede depender de otro elemento.",
    );
  for (const node of blueprint.nodes) {
    if (
      Object.keys(node.data).some((key) => !templateFields.has(key)) ||
      (node.data.personalNote !== undefined && node.kind !== "document") ||
      (node.data.personalNote && !!node.parentKey) ||
      (node.kind !== "document" && node.data.content !== undefined)
    )
      throw new HttpError(
        400,
        "La plantilla contiene campos que no se pueden copiar.",
      );
    if (node.parentKey && nodes.get(node.parentKey)?.data.personalNote)
      throw new HttpError(
        400,
        "Una plantilla de nota personal no contiene otros elementos.",
      );
    resourceDataSchema.parse(node.data);
    if (
      (node.kind === "project" && node.projectKey) ||
      (node.kind !== "document" && node.personal)
    )
      throw new HttpError(
        400,
        "El contexto del elemento de plantilla no es válido.",
      );
    if (root.kind !== "project" && node.kind !== root.kind)
      throw new HttpError(
        400,
        "Esta plantilla solo admite elementos del mismo tipo que su raíz.",
      );
    if (
      (node.projectKey && nodes.get(node.projectKey)?.kind !== "project") ||
      (node.parentKey &&
        !(
          nodes.get(node.parentKey)?.kind === node.kind && node.kind === "task"
        ) &&
        !acceptsChild(
          nodes.get(node.parentKey)?.kind as Resource["kind"],
          node.kind,
        ))
    )
      throw new HttpError(
        400,
        "Las relaciones de la plantilla no son válidas.",
      );
    for (const key of [...node.dependencies, ...node.related])
      if (
        key === node.key ||
        !nodes.has(key) ||
        (node.dependencies.includes(key) && nodes.get(key)?.kind !== "task")
      )
        throw new HttpError(400, "Una relación de la plantilla no es válida.");
    if (node.kind !== "task" && node.dependencies.length)
      throw new HttpError(400, "Solo las tareas pueden tener dependencias.");
    const seen = new Set<string>();
    let cursor: typeof node | undefined = node;
    while (cursor && cursor.key !== blueprint.rootKey) {
      if (seen.has(cursor.key))
        throw new HttpError(400, "La jerarquía de plantilla crea un ciclo.");
      seen.add(cursor.key);
      const parent: string | undefined = cursor.parentKey || cursor.projectKey;
      cursor = parent ? nodes.get(parent) : undefined;
    }
    if (!cursor)
      throw new HttpError(
        400,
        "Todos los elementos deben pertenecer a la raíz de la plantilla.",
      );
    if (node.data.content) {
      try {
        rewriteDocument(node.data.content, (n) => {
          for (const mark of n.marks || [])
            if (mark.type === "link") {
              const href = String(mark.attrs?.href || "");
              if (
                /[\u0000-\u001f\u007f]/.test(href) ||
                !(
                  /^(https?:\/\/|mailto:|#)/i.test(href) ||
                  (href.startsWith("/") && !href.startsWith("//"))
                )
              )
                throw new Error("Unsafe template link");
              const target = /^\/\?templateNode=([A-Za-z0-9_-]+)$/.exec(
                href,
              )?.[1];
              if (target && !nodes.has(target))
                throw new Error("Unknown template target");
            }
          return n;
        });
        validateDocumentContent(node.data.content);
        const document = schema.nodeFromJSON(node.data.content);
        document.check();
      } catch {
        throw new HttpError(
          400,
          "El documento de plantilla no es válido o supera su límite de estructura.",
        );
      }
    }
  }
  for (const node of blueprint.nodes) {
    const visiting = new Set<string>(),
      visited = new Set<string>(),
      stack: { key: string; exit: boolean }[] = [
        { key: node.key, exit: false },
      ];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.exit) {
        visiting.delete(current.key);
        visited.add(current.key);
        continue;
      }
      if (visiting.has(current.key))
        throw new HttpError(
          400,
          "Las dependencias de plantilla crean un ciclo.",
        );
      if (visited.has(current.key)) continue;
      visiting.add(current.key);
      stack.push({ ...current, exit: true });
      for (const next of nodes.get(current.key)!.dependencies)
        stack.push({ key: next, exit: false });
    }
  }
  if (Buffer.byteLength(JSON.stringify(blueprint)) > 1024 * 1024)
    throw new HttpError(
      413,
      "La plantilla puede guardar hasta 1 MiB de contenido estructurado.",
    );
  return blueprint;
}
export async function validateCollectionMutation(
  tx: Connection,
  proposed: Resource,
  previous: Resource | undefined,
  userId: string,
  role: Role,
  all: Resource[],
  trustedCapture = false,
) {
  if (!["view", "template"].includes(proposed.kind)) return;
  if (previous && previous.created_by !== userId && role !== "admin")
    throw new HttpError(
      403,
      "Solo el autor o un administrador puede modificar este elemento.",
    );
  if (proposed.deleted_at) return;
  if (proposed.kind === "view" && proposed.data.viewConfig) {
    const config = taskViewSchema.parse(proposed.data.viewConfig);
    for (const reference of [...config.fieldFilters, ...config.fieldColumns]) {
      const project = all.find(
        (r) =>
          r.id === reference.projectId && r.kind === "project" && !r.deleted_at,
      );
      const definition = project?.data.fieldDefinitions?.find(
        (f: any) => f.id === reference.fieldId,
      );
      if (!project || !definition || !canRead(project, userId, role, all))
        throw new HttpError(
          400,
          "Un campo de la vista no está disponible para esta cuenta.",
        );
      if ("operator" in reference) {
        const issue = fieldFilterError(definition, reference as FieldFilter);
        if (issue) throw new HttpError(400, issue);
      }
    }
    if (!validTimeZone(config.timeZone))
      throw new HttpError(400, "La zona horaria de la vista no es válida.");
    for (const [field, kind] of [
      ["projectIds", "project"],
      ["sprintIds", "sprint"],
    ] as const)
      for (const id of config[field]) {
        const target = all.find((r) => r.id === id && !r.deleted_at);
        if (
          !target ||
          target.kind !== kind ||
          !canRead(target, userId, role, all)
        )
          throw new HttpError(
            400,
            "Un filtro de la vista no está disponible para esta cuenta.",
          );
      }
  }
  if (proposed.kind === "template") {
    if (Buffer.byteLength(JSON.stringify(proposed.data)) > 900 * 1024)
      throw new HttpError(
        413,
        "La plantilla completa admite hasta 900 KiB de contenido y contexto.",
      );
    if (
      !trustedCapture &&
      (!isDeepStrictEqual(
        proposed.data.templateScopes || [],
        previous?.data.templateScopes || [],
      ) ||
        (previous?.data.templateScopes?.length &&
          proposed.data.targetId !== previous.data.targetId))
    )
      throw new HttpError(
        400,
        "El contexto de origen de una plantilla capturada no se puede sustituir.",
      );
    if (proposed.data.templateBlueprint) {
      const blueprint = validateBlueprint(proposed.data.templateBlueprint);
      if (!trustedCapture) {
        const files = (
          await tx.query(
            "SELECT id FROM attachments WHERE workspace_id=$1 AND target_id=$2 AND deleted_at IS NULL",
            [proposed.workspace_id, proposed.id],
          )
        ).rows;
        for (const node of blueprint.nodes)
          if (node.data.content)
            rewriteDocument(node.data.content, (element) => {
              if (element.type === "image") {
                const source = String(element.attrs?.src || ""),
                  match = new RegExp(
                    "^/api/workspaces/" +
                      proposed.workspace_id +
                      "/attachments/([a-f\\d-]{36})$",
                    "i",
                  ).exec(source);
                if (!match || !files.some((file) => file.id === match[1]))
                  throw new HttpError(
                    400,
                    "Las imágenes de plantilla deben pertenecer a sus adjuntos capturados.",
                  );
              }
              return element;
            });
      }
    }
  }
}
