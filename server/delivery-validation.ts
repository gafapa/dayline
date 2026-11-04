import { belongsToProject, deliveryDraftIssues } from "../shared/delivery.js";
import { isDeepStrictEqual } from "node:util";
import {
  deliverySchema,
  deliveryReadinessIssues,
  deliveryStatuses,
  deliveryIds,
  isDelivery,
} from "../shared/delivery.js";
import { validDay } from "../shared/time.js";
import type { Connection } from "./database.js";
import type { Resource, Role } from "../shared/model.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";

export async function validateDeliveryMutation(
  tx: Connection,
  proposed: Resource,
  previous: Resource | undefined,
  all: Resource[],
  userId: string,
  role: Role,
  trusted = false,
) {
  if (!isDelivery(proposed)) {
    if (proposed.data.delivery || proposed.data.deliveryReceipt)
      throw new HttpError(
        400,
        "Este tipo no admite planificación de entregas.",
      );
    return;
  }
  if (Buffer.byteLength(JSON.stringify(proposed.data)) > 900 * 1024)
    throw new HttpError(
      413,
      "El registro completo de planificación admite hasta 900 KiB.",
    );
  if (
    !trusted &&
    (!isDeepStrictEqual(
      proposed.data.deliveryReceipt,
      previous?.data.deliveryReceipt,
    ) ||
      proposed.data.delivery?.supersededById !==
        previous?.data.delivery?.supersededById)
  )
    throw new HttpError(
      400,
      "Las confirmaciones de entrega solo se generan con la acción correspondiente.",
    );
  if (trusted && previous?.data.deliveryReceipt) return;
  if (previous?.data.deliveryReceipt && !trusted) {
    const clean = (resource: Resource) => ({
      ...resource.data,
      archived: undefined,
      followers: undefined,
    });
    if (
      proposed.title !== previous.title ||
      !isDeepStrictEqual(clean(proposed), clean(previous))
    )
      throw new HttpError(
        409,
        "Este registro confirmado conserva su contenido histórico. Puedes archivarlo o crear una nueva decisión que lo sustituya.",
      );
    return;
  }
  if (proposed.deleted_at) return;
  const value = deliverySchema.parse(proposed.data.delivery);
  if (
    value.type !== proposed.kind ||
    !deliveryStatuses[proposed.kind].includes(proposed.data.status)
  )
    throw new HttpError(
      400,
      "El tipo o el estado de planificación no es válido.",
    );
  const project = all.find(
    (r) =>
      r.id === proposed.data.projectId &&
      r.kind === "project" &&
      !r.deleted_at &&
      !r.data.archived,
  );
  if (!project || !canRead(project, userId, role, all))
    throw new HttpError(400, "Elige un proyecto activo y accesible.");
  for (const field of ["startDate", "dueDate", "endDate"])
    if (proposed.data[field] && !validDay(proposed.data[field]))
      throw new HttpError(400, "La fecha de planificación no es válida.");
  if (
    proposed.data.startDate &&
    proposed.data.dueDate &&
    proposed.data.startDate > proposed.data.dueDate
  )
    throw new HttpError(400, "El inicio debe ser anterior al vencimiento.");
  if (proposed.data.repository) {
    const url = new URL(proposed.data.repository);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new HttpError(
        400,
        "Usa un enlace HTTPS de repositorio sin credenciales.",
      );
  }
  const fields =
    value.type === "milestone"
      ? [
          ["taskIds", "task"],
          ["dependsOn", "milestone"],
        ]
      : value.type === "release"
        ? [
            ["taskIds", "task"],
            ["milestoneIds", "milestone"],
            ["riskIds", "risk"],
          ]
        : value.type === "decision"
          ? [["supersedesId", "decision"]]
          : [];
  for (const [field, kind] of fields) {
    const raw = (value as any)[field],
      ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (new Set(ids).size !== ids.length)
      throw new HttpError(400, "El alcance contiene elementos duplicados.");
    for (const id of ids) {
      const target = all.find((r) => r.id === id && !r.deleted_at);
      if (
        id === proposed.id ||
        !target ||
        target.kind !== kind ||
        !belongsToProject(target, project.id, all) ||
        !canRead(target, userId, role, all)
      )
        throw new HttpError(
          400,
          "Una referencia de planificación no está disponible dentro de este proyecto.",
        );
    }
  }
  if (value.type === "milestone") {
    const graph = new Map(
      all
        .filter((r) => r.kind === "milestone")
        .map((r) => [r.id, r.data.delivery?.dependsOn || []]),
    );
    graph.set(proposed.id, value.dependsOn);
    const stack = [...value.dependsOn],
      seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === proposed.id)
        throw new HttpError(
          400,
          "Las dependencias entre hitos crean un ciclo.",
        );
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 500)
        throw new HttpError(
          413,
          "El conjunto de dependencias admite hasta 500 hitos.",
        );
      stack.push(...(graph.get(id) || []));
    }
  }
  const issue = deliveryDraftIssues(proposed.data)[0];
  if (issue) throw new HttpError(400, issue);
  if (value.type === "decision") {
    if (value.supersedesId) {
      const old = all.find((r) => r.id === value.supersedesId);
      if (old?.data.status !== "accepted")
        throw new HttpError(
          400,
          "Solo puedes sustituir una decisión aceptada y vigente.",
        );
    }
    if (proposed.data.status === "superseded" && !trusted)
      throw new HttpError(
        400,
        "La sustitución se registra al aceptar la nueva decisión.",
      );
  }
  if (proposed.data.assigneeId) {
    const assignee = (
      await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [proposed.workspace_id, proposed.data.assigneeId],
      )
    ).rows[0];
    if (
      !assignee ||
      !canRead(proposed, proposed.data.assigneeId, assignee.role, [
        ...all.filter((r) => r.id !== proposed.id),
        proposed,
      ])
    )
      throw new HttpError(
        400,
        "La persona responsable debe tener acceso al registro y a su alcance.",
      );
  }
  const final =
    proposed.kind === "milestone"
      ? "achieved"
      : proposed.kind === "release"
        ? "released"
        : proposed.kind === "decision"
          ? "accepted"
          : null;
  if (
    final &&
    proposed.data.status === final &&
    previous?.data.status !== final &&
    !trusted
  )
    throw new HttpError(
      400,
      "Usa la acción de confirmar para conservar el alcance y sus comprobaciones.",
    );
  if (
    value.type === "release" &&
    proposed.data.status === "ready" &&
    !trusted
  ) {
    const readiness = deliveryReadiness(proposed, all, userId, role);
    if (!readiness.ready)
      throw new HttpError(
        400,
        "Completa las condiciones de entrega antes de marcar la versión como preparada.",
        { issues: readiness.issues },
      );
  }
}

export function deliveryReadiness(
  resource: Resource,
  all: Resource[],
  userId: string,
  role: Role,
) {
  if (!isDelivery(resource) || !resource.data.delivery)
    throw new HttpError(
      400,
      "Configura primero este registro de planificación.",
    );
  const references = new Map<string, Resource>(),
    queue = [
      ...deliveryIds(resource),
      resource.data.projectId,
      resource.data.parentId,
      resource.data.targetId,
    ].filter(Boolean);
  while (queue.length) {
    const id = queue.pop()!;
    if (references.has(id) || id === resource.id) continue;
    const target = all.find((r) => r.id === id && !r.deleted_at);
    if (!target || !canRead(target, userId, role, all))
      throw new HttpError(
        404,
        "Parte del alcance de planificación ya no está disponible.",
      );
    references.set(id, target);
    if (references.size > 500)
      throw new HttpError(
        413,
        "La confirmación admite hasta 500 elementos de alcance y permisos.",
      );
    queue.push(...deliveryIds(target));
    if (target.data.projectId) queue.push(target.data.projectId);
    if (target.data.parentId) queue.push(target.data.parentId);
    if (target.data.targetId) queue.push(target.data.targetId);
    if (target.kind === "task") queue.push(...(target.data.dependencies || []));
  }
  const refs = [...references.values()],
    issues = deliveryReadinessIssues(resource, refs);
  return { resource, references: refs, issues, ready: issues.length === 0 };
}
