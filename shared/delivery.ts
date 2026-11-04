import { z } from "zod";
import { templateScopeSchema } from "./collections.js";
import { validDay } from "./time.js";
import type { Resource } from "./model.js";
const id = z.string().uuid(),
  text = z.string().max(100000),
  short = z.string().max(500),
  ids = z.array(id).max(200);
export const deliveryKinds = [
  "milestone",
  "release",
  "risk",
  "decision",
] as const;
export type DeliveryKind = (typeof deliveryKinds)[number];
export const deliverySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("milestone"),
      taskIds: ids.default([]),
      dependsOn: z.array(id).max(50).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("release"),
      version: z.string().trim().min(1).max(80),
      taskIds: ids.default([]),
      milestoneIds: z.array(id).max(50).default([]),
      riskIds: z.array(id).max(100).default([]),
      notes: text.default(""),
      tag: z.string().max(100).default(""),
    })
    .strict(),
  z
    .object({
      type: z.literal("risk"),
      probability: z.number().int().min(1).max(5).default(3),
      impact: z.number().int().min(1).max(5).default(3),
      mitigation: text.default(""),
      contingency: text.default(""),
      dispositionReason: text.default(""),
      reviewDate: z
        .string()
        .refine((v) => v === "" || validDay(v))
        .default(""),
    })
    .strict(),
  z
    .object({
      type: z.literal("decision"),
      options: z
        .array(z.object({ id, label: short, tradeoffs: text }).strict())
        .max(20)
        .default([]),
      chosenOptionId: id.optional(),
      rationale: text.default(""),
      supersedesId: id.optional(),
      supersededById: id.optional(),
    })
    .strict(),
]);
export const deliveryReceiptSchema = z
  .object({
    at: z.string().datetime(),
    actorId: id,
    version: z.number().int().positive(),
    finalStatus: z.enum(["achieved", "released", "accepted"]),
    scopes: z.array(templateScopeSchema).max(500),
    items: z
      .array(
        z
          .object({
            id,
            kind: short,
            title: short,
            version: z.number().int().positive(),
            status: short,
            estimate: z.number().optional(),
            dueDate: short.optional(),
            summary: text.optional(),
            riskScore: z.number().int().min(1).max(25).optional(),
          })
          .strict(),
      )
      .max(500),
    checklist: z
      .array(z.object({ id: short, text: short, done: z.boolean() }).strict())
      .max(300),
    note: text,
  })
  .strict();
export const deliveryStatuses: Record<DeliveryKind, string[]> = {
  milestone: ["planned", "active", "achieved", "cancelled"],
  release: ["planned", "in_progress", "ready", "released", "cancelled"],
  risk: ["identified", "mitigating", "accepted", "resolved"],
  decision: ["proposed", "accepted", "rejected", "superseded"],
};
export const deliveryStatusLabels: Record<string, string> = {
  planned: "Planificado",
  active: "En curso",
  achieved: "Alcanzado",
  cancelled: "Cancelado",
  in_progress: "En preparación",
  ready: "Lista para publicar",
  released: "Publicada",
  identified: "Identificado",
  mitigating: "En mitigación",
  accepted: "Aceptado",
  resolved: "Resuelto",
  proposed: "Propuesta",
  rejected: "Rechazada",
  superseded: "Sustituida",
};
export function defaultDelivery(type: DeliveryKind) {
  return deliverySchema.parse(
    type === "release" ? { type, version: "0.1.0" } : { type },
  );
}
export function deliveryIds(resource: Resource): string[] {
  const value = resource.data.delivery;
  if (!value) return [];
  return value.type === "milestone"
    ? [...(value.taskIds || []), ...(value.dependsOn || [])]
    : value.type === "release"
      ? [
          ...(value.taskIds || []),
          ...(value.milestoneIds || []),
          ...(value.riskIds || []),
        ]
      : value.type === "decision"
        ? [value.supersedesId].filter(Boolean)
        : [];
}
export function isDelivery(
  resource: Resource,
): resource is Resource & { kind: DeliveryKind } {
  return (deliveryKinds as readonly string[]).includes(resource.kind);
}
export function deliveryDraftIssues(data: Record<string, any>): string[] {
  const parsed = deliverySchema.safeParse(data.delivery);
  if (!parsed.success) return ["Revisa los campos de planificación."];
  const value = parsed.data,
    issues: string[] = [];
  if (value.type === "risk") {
    if (
      ["mitigating", "accepted", "resolved"].includes(data.status) &&
      !data.assigneeId
    )
      issues.push("Asigna una persona responsable del riesgo.");
    if (
      ["mitigating", "resolved"].includes(data.status) &&
      !value.mitigation.trim()
    )
      issues.push("Describe la mitigación del riesgo.");
    if (data.status === "accepted" && !value.dispositionReason.trim())
      issues.push("Documenta el motivo para aceptar el riesgo.");
  }
  if (value.type === "decision") {
    if (new Set(value.options.map((o) => o.id)).size !== value.options.length)
      issues.push("Las alternativas deben tener identificadores distintos.");
    if (value.options.some((o) => !o.label.trim()))
      issues.push("Pon un nombre a cada alternativa.");
    if (
      value.chosenOptionId &&
      !value.options.some((o) => o.id === value.chosenOptionId)
    )
      issues.push("La alternativa elegida no está disponible.");
  }
  if (data.repository) {
    try {
      const url = new URL(data.repository);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
    } catch {
      issues.push("Usa un enlace HTTPS de repositorio sin credenciales.");
    }
  }
  if (data.startDate && data.dueDate && data.startDate > data.dueDate)
    issues.push("El inicio debe ser anterior al vencimiento.");
  return issues;
}
export function belongsToProject(
  resource: Resource,
  projectId: string,
  all: Resource[],
) {
  let next =
    resource.kind === "project" ? resource.id : resource.data.projectId;
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    if (next === projectId) return true;
    seen.add(next);
    next = all.find((r) => r.id === next && r.kind === "project")?.data
      .parentId;
  }
  return false;
}

export function deliveryReadinessIssues(resource: Resource, refs: Resource[]) {
  const value = deliverySchema.parse(resource.data.delivery),
    references = new Map(refs.map((r) => [r.id, r])),
    issues: { id?: string; message: string }[] = [];
  if (resource.data.deliveryReceipt)
    issues.push({
      message: "El registro ya está confirmado y conserva su historial.",
    });
  if (
    ["cancelled", "rejected", "superseded"].includes(resource.data.status) ||
    resource.data.archived
  )
    issues.push({ message: "Reactiva el registro antes de confirmarlo." });
  if (value.type === "milestone" || value.type === "release") {
    if (!resource.data.goal?.trim())
      issues.push({ message: "Define el objetivo de la entrega." });
    if (
      !value.taskIds.length &&
      (value.type !== "release" || !value.milestoneIds.length)
    )
      issues.push({
        message: "Selecciona al menos una tarea o un hito de alcance.",
      });
    for (const task of refs.filter((r) => r.kind === "task"))
      if (!["done", "cancelled"].includes(task.data.status))
        issues.push({ id: task.id, message: `Tarea pendiente: ${task.title}` });
    const milestoneIds =
      value.type === "milestone" ? value.dependsOn : value.milestoneIds;
    for (const id of milestoneIds)
      if (references.get(id)?.data.status !== "achieved")
        issues.push({
          id,
          message: `Hito pendiente: ${references.get(id)?.title}`,
        });
    if (value.type === "release") {
      if (!(resource.data.checklist || []).length)
        issues.push({
          message: "Añade una lista de comprobación de publicación.",
        });
      for (const id of value.riskIds)
        if (!["accepted", "resolved"].includes(references.get(id)?.data.status))
          issues.push({
            id,
            message: `Riesgo sin resolver o aceptar: ${references.get(id)?.title}`,
          });
    }
  }
  if (value.type === "decision") {
    if (value.options.length < 2)
      issues.push({ message: "Describe al menos dos alternativas." });
    if (!value.chosenOptionId)
      issues.push({ message: "Selecciona la alternativa elegida." });
    if (!value.rationale.trim())
      issues.push({ message: "Documenta el motivo de la decisión." });
    if (
      value.supersedesId &&
      references.get(value.supersedesId)?.data.status !== "accepted"
    )
      issues.push({
        message: "La decisión que se quiere sustituir ya no está vigente.",
      });
  }
  if (value.type === "risk")
    issues.push({
      message: "Gestiona el estado del riesgo desde sus medidas y responsable.",
    });
  for (const item of resource.data.checklist || [])
    if (!item.done)
      issues.push({ message: `Comprobación pendiente: ${item.text}` });
  return issues;
}

export function localDeliveryReadinessIssues(
  resource: Resource,
  all: Resource[],
) {
  const refs = new Map<string, Resource>(),
    queue = [
      ...deliveryIds(resource),
      resource.data.projectId,
      resource.data.parentId,
      resource.data.targetId,
    ].filter(Boolean);
  while (queue.length) {
    const id = queue.pop()!;
    if (refs.has(id) || id === resource.id) continue;
    const target = all.find((r) => r.id === id && !r.deleted_at);
    if (!target)
      return [
        {
          message: "Parte del alcance no está disponible en este dispositivo.",
        },
      ];
    refs.set(id, target);
    if (refs.size > 500)
      return [{ message: "El alcance supera 500 elementos." }];
    queue.push(
      ...[
        ...deliveryIds(target),
        target.data.projectId,
        target.data.parentId,
        target.data.targetId,
        ...(target.kind === "task" ? target.data.dependencies || [] : []),
      ].filter(Boolean),
    );
  }
  return deliveryReadinessIssues(resource, [...refs.values()]);
}
