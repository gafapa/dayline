import { z } from "zod";
import type { Resource, User } from "./model.js";
import {
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SEED_VERSION,
} from "./document-protocol.js";
import { isStructure, projectAt } from "./hierarchy.js";
import { customFieldValueSchema } from "./custom-fields.js";
import { validDay } from "./time.js";

export const captureDraftSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["private_note", "task", "document"]),
    title: z.string().max(500),
    text: z
      .string()
      .max(50000)
      .refine(
        (value) => value.split(/\r\n?|\n/).length <= 5000,
        "La captura admite hasta 5000 líneas.",
      ),
    sourceUrl: z.string().max(1000),
    destinationId: z.string().uuid().or(z.literal("")),
    assignToMe: z.boolean(),
    dueDate: z.string().max(10),
    customFields: z
      .record(z.string().max(80), customFieldValueSchema)
      .refine((value) => Object.keys(value).length <= 80),
  })
  .strict();
export type CaptureDraft = z.infer<typeof captureDraftSchema>;
export function captureSourceUrl(value: string) {
  const text = value.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      "El enlace de origen debe ser una dirección http o https completa.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\u0000-\u001f\u007f]/.test(text) ||
    url.href.length > 1000
  )
    throw new Error(
      "El enlace de origen debe ser http o https, sin credenciales y de hasta 1000 caracteres.",
    );
  return url.href;
}
export function captureDocument(text: string, sourceUrl: string) {
  sourceUrl = captureSourceUrl(sourceUrl);
  if (text.length > 50000 || text.split(/\r\n?|\n/).length > 5000)
    throw new Error("La captura admite hasta 50000 caracteres y 5000 líneas.");
  const paragraphs: any[] = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    }));
  if (sourceUrl)
    paragraphs.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: sourceUrl,
          marks: [
            {
              type: "link",
              attrs: {
                href: sourceUrl,
                target: "_blank",
                rel: "noopener noreferrer nofollow",
              },
            },
          ],
        },
      ],
    });
  return { type: "doc", content: paragraphs };
}
export function buildCapturedResource(
  value: CaptureDraft,
  user: User,
  workspaceId: string,
  resources: Resource[],
  now = new Date(),
): Resource {
  const parsed = captureDraftSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Revisa el título, el contenido y las opciones de la captura. El contenido admite hasta 50000 caracteres y 5000 líneas.",
    );
  const draft = parsed.data,
    title = draft.title.trim(),
    url = captureSourceUrl(draft.sourceUrl);
  if (!title) throw new Error("Escribe un título para la captura.");
  const destination = draft.destinationId
    ? resources.find(
        (resource) =>
          resource.id === draft.destinationId &&
          !resource.deleted_at &&
          !resource.data.archived,
      )
    : undefined;
  const data: Record<string, any> = {};
  if (draft.kind === "private_note") {
    data.personalNote = true;
    data.ownerId = user.id;
  } else if (draft.destinationId) {
    if (
      !destination ||
      destination.workspace_id !== workspaceId ||
      (draft.kind === "task"
        ? destination.kind !== "project"
        : !isStructure(destination))
    )
      throw new Error(
        "La ubicación ya no está disponible para esta captura. Selecciona otra ubicación.",
      );
    if (draft.kind === "task") data.projectId = destination.id;
    else {
      data.parentId = destination.id;
      const projectId = projectAt(destination.id, resources);
      if (projectId) data.projectId = projectId;
    }
  }
  if (draft.kind === "task") {
    data.status = "backlog";
    data.taskType = "feature";
    data.priority = "none";
    data.description = draft.text;
    if (draft.assignToMe) data.assigneeId = user.id;
    if (draft.dueDate) {
      if (!validDay(draft.dueDate))
        throw new Error("La fecha límite no es válida.");
      data.dueDate = draft.dueDate;
    }
    if (Object.keys(draft.customFields).length)
      data.customFields = draft.customFields;
  } else {
    data.content = captureDocument(draft.text, url);
    data.documentSchemaVersion = DOCUMENT_SCHEMA_VERSION;
    data.documentSeedVersion = DOCUMENT_SEED_VERSION;
    data.description = draft.text.slice(0, 280);
  }
  if (url) data.url = url;
  return {
    id: draft.id,
    workspace_id: workspaceId,
    kind: draft.kind === "task" ? "task" : "document",
    title,
    data,
    version: 0,
    created_by: user.id,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    deleted_at: null,
  };
}
