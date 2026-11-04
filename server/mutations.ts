import { validatePersonalNote } from "./personal-notes.js";
import { validateWorkflowData } from "./workflow-validation.js";
import * as Y from "yjs";
import { initialDocument } from "../shared/document-seed.js";
import { validateReminder, cancelPendingReminder } from "./reminders.js";
import { isDeepStrictEqual } from "node:util";
import { validateTimeEntry } from "./time-tracking-validation.js";
import {
  validateDashboardMutation,
  dashboardHistoryScopes,
} from "./analytics.js";
import { validateDocumentContent } from "./document-validation.js";
import type { Connection } from "./database.js";
import type { Resource, Role, User, Mutation } from "../shared/model.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import { validateAutomation, enqueueTaskEvents } from "./automations.js";
import { validateSprintMutation, captureSprintBaseline } from "./sprints.js";
import { notifyChange } from "./notifications.js";
import { validateCollectionMutation } from "./collection-validation.js";
import { validateDeliveryMutation } from "./delivery-validation.js";
import { validateHierarchyMutation } from "./hierarchy-validation.js";
import {
  validateCustomFieldData,
  type FieldOptions,
} from "./custom-field-validation.js";
export async function resources(
  tx: Connection,
  workspaceId: string,
): Promise<Resource[]> {
  return (
    await tx.query<Resource>(
      "SELECT * FROM resources WHERE workspace_id=$1 ORDER BY updated_at DESC",
      [workspaceId],
    )
  ).rows;
}
export async function applyMutation(
  tx: Connection,
  workspaceId: string,
  user: User,
  role: Role,
  input: Mutation,
  options: {
    skipOperation?: boolean;
    graph?: Resource[];
    existing?: Resource;
    trustedTemplateCapture?: boolean;
    deliveryFinalization?: boolean;
    hierarchyMove?: boolean;
  } & FieldOptions = {},
) {
  const all = options.graph || (await resources(tx, workspaceId));
  if (input.data.documentSeedVersion !== undefined && input.kind !== "document")
    throw new HttpError(400, "El estado inicial pertenece a un documento.");
  if (
    input.kind === "document" &&
    input.data.content !== undefined &&
    input.data.content !== null
  )
    validateDocumentContent(input.data.content);
  const prior = options.skipOperation
    ? null
    : (
        await tx.query(
          "SELECT response,workspace_id,user_id FROM operations WHERE id=$1",
          [input.operationId],
        )
      ).rows[0];
  if (prior) {
    if (prior.workspace_id !== workspaceId || prior.user_id !== user.id)
      throw new HttpError(409, "Identificador de operación ya utilizado.");
    if (
      !prior.response.resource ||
      prior.response.resource.id !== input.id ||
      prior.response.resource.kind !== input.kind ||
      (prior.response.command && prior.response.command !== "resource_mutation")
    )
      throw new HttpError(409, "Identificador de operación ya utilizado.");
    const current = all.find((r) => r.id === prior.response.resource?.id);
    if (
      !current ||
      !canRead(current, user.id, role, all) ||
      !canRead(prior.response.resource, user.id, role, all) ||
      (prior.response.dashboardScopes &&
        !canRead(
          {
            ...prior.response.resource,
            data: {
              ...prior.response.resource.data,
              dashboardScopes: prior.response.dashboardScopes,
            },
          },
          user.id,
          role,
          all,
        ))
    )
      throw new HttpError(
        403,
        "El elemento ya no está disponible para esta cuenta.",
      );
    if (
      prior.response.resource.id !== input.id ||
      prior.response.resource.kind !== input.kind ||
      (prior.response.command && prior.response.command !== "resource_mutation")
    )
      throw new HttpError(409, "Identificador de operación ya utilizado.");
    return prior.response;
  }
  const existing =
    options.existing || all.find((r) => r.id === input.id && r.version > 0);
  if (role === "viewer") {
    const before = { ...existing?.data },
      after = { ...input.data };
    delete before.read;
    delete after.read;
    if (
      !existing ||
      existing.kind !== "notification" ||
      existing.data.assigneeId !== user.id ||
      input.title !== existing.title ||
      input.deleted ||
      !isDeepStrictEqual(before, after)
    )
      throw new HttpError(
        403,
        "Solo puedes marcar tus notificaciones como leídas.",
      );
  }
  if (existing && !canRead(existing, user.id, role, all))
    throw new HttpError(403, "No tienes acceso a este elemento.");
  if (
    existing &&
    existing.data.documentSeedVersion !== input.data.documentSeedVersion
  )
    throw new HttpError(
      409,
      "El documento conserva su formato de estado inicial.",
    );
  if (existing?.kind !== input.kind && existing)
    throw new HttpError(400, "No se puede cambiar el tipo del elemento.");
  if ((existing?.version || 0) !== input.expectedVersion)
    throw new HttpError(
      409,
      "Hay cambios de otra persona. Revisa ambas versiones.",
      { current: existing || null },
    );
  if (
    !existing &&
    (await tx.query("SELECT id FROM resources WHERE id=$1", [input.id])).rows
      .length
  )
    throw new HttpError(409, "El identificador ya existe.");
  const proposed: Resource = {
    ...(existing || {}),
    id: input.id,
    workspace_id: workspaceId,
    kind: input.kind,
    title: input.title,
    data: input.data,
    created_by: existing?.created_by || user.id,
    deleted_at: input.deleted
      ? options.hierarchyMove && existing?.deleted_at
        ? existing.deleted_at
        : new Date().toISOString()
      : null,
  } as Resource;
  proposed.data = await validateCustomFieldData(
    tx,
    proposed,
    existing,
    all,
    user,
    role,
    options,
  );
  proposed.data = validateWorkflowData(proposed, existing, all, user, role);
  input = { ...input, data: proposed.data };
  validateHierarchyMutation(proposed, existing, all, options.hierarchyMove);
  validateTimeEntry(proposed, existing, all, user.id, role);
  validatePersonalNote(proposed, existing, all, user.id);
  await validateReminder(tx, proposed, existing, all, user.id);
  validateDashboardMutation(proposed, existing, all, user.id, role);
  await validateCollectionMutation(
    tx,
    proposed,
    existing,
    user.id,
    role,
    all,
    options.trustedTemplateCapture,
  );
  await validateAutomation(tx, proposed, existing, user.id, role, all);
  await validateDeliveryMutation(
    tx,
    proposed,
    existing,
    all,
    user.id,
    role,
    options.deliveryFinalization,
  );
  await validateSprintMutation(tx, proposed, existing, all, user.id, role);
  if (input.data.ownerId && input.data.ownerId !== user.id)
    throw new HttpError(403, "Las notas privadas pertenecen a su autor.");
  if (
    input.data.ownerId &&
    ![
      "document",
      "view",
      "time_entry",
      "template",
      "dashboard",
      "reminder",
    ].includes(input.kind)
  )
    throw new HttpError(
      400,
      "Este tipo de elemento no admite propiedad personal.",
    );
  if (
    existing &&
    input.data.ownerId !== existing.data.ownerId &&
    existing.created_by !== user.id
  )
    throw new HttpError(
      403,
      "No puedes cambiar la propiedad personal de otro autor.",
    );
  if (
    input.kind === "task" &&
    input.data.status &&
    !["backlog", "todo", "in_progress", "review", "done", "cancelled"].includes(
      input.data.status,
    )
  )
    throw new HttpError(400, "El estado de la tarea no es válido.");
  if (
    input.kind === "sprint" &&
    input.data.status &&
    !["planned", "active", "completed"].includes(input.data.status)
  )
    throw new HttpError(400, "El estado del sprint no es válido.");
  if (
    (input.data.private !== existing?.data.private ||
      JSON.stringify(input.data.members) !==
        JSON.stringify(existing?.data.members)) &&
    existing &&
    role !== "admin" &&
    existing.created_by !== user.id
  )
    throw new HttpError(
      403,
      "Solo el propietario puede cambiar la privacidad.",
    );
  for (const field of [
    "projectId",
    "parentId",
    "teamId",
    "sprintId",
    "targetId",
  ] as const) {
    const ref = input.data[field];
    if (!ref) continue;
    const target = all.find((r) => r.id === ref && !r.deleted_at);
    if (target && field === "projectId" && !canRead(target, user.id, role, all))
      throw new HttpError(403, "No puedes crear elementos en este proyecto.");
    if (
      target?.kind === "time_entry" &&
      !["comment", "notification"].includes(input.kind)
    )
      throw new HttpError(
        400,
        "Un registro de tiempo no puede contener otros elementos.",
      );
    if (ref === input.id || !target || !canRead(target, user.id, role, all))
      throw new HttpError(400, "La relación no es válida.");
    if (
      (field === "projectId" && target.kind !== "project") ||
      (field === "sprintId" && target.kind !== "sprint") ||
      (field === "teamId" && target.kind !== "team")
    )
      throw new HttpError(400, "El tipo de relación no es válido.");
  }
  if (
    !canRead(proposed, user.id, role, [
      ...all.filter((r) => r.id !== input.id),
      proposed,
    ])
  )
    throw new HttpError(403, "No puedes crear elementos en este proyecto.");
  if (input.data.parentId) {
    const seen = new Set([input.id]);
    let cursor: string | undefined = input.data.parentId;
    while (cursor) {
      if (seen.has(cursor))
        throw new HttpError(400, "La relación crea un ciclo.");
      seen.add(cursor);
      cursor = all.find((r) => r.id === cursor)?.data.parentId;
    }
  }
  for (const field of ["dependencies", "related"] as const) {
    for (const id of input.data[field] || []) {
      const target = all.find((r) => r.id === id && !r.deleted_at);
      if (
        id === input.id ||
        !target ||
        !canRead(target, user.id, role, all) ||
        (field === "dependencies" && target.kind !== "task")
      )
        throw new HttpError(400, "La relación entre tareas no es válida.");
    }
  }
  if (input.kind === "task") {
    const graph = new Map(
      all
        .filter((r) => r.kind === "task")
        .map((r) => [r.id, r.data.dependencies || []]),
    );
    graph.set(input.id, input.data.dependencies || []);
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id))
        throw new HttpError(400, "Las dependencias crean un ciclo.");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) || []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    visit(input.id);
  }
  if (
    (input.data.followers?.length || 0) + (input.data.reviewers?.length || 0) >
    0
  ) {
    const ids = [
      ...new Set([
        ...(input.data.followers || []),
        ...(input.data.reviewers || []),
      ]),
    ];
    const members = (
      await tx.query(
        "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=ANY($2::uuid[])",
        [workspaceId, ids],
      )
    ).rows;
    if (members.length !== ids.length)
      throw new HttpError(
        400,
        "Los participantes deben pertenecer al espacio.",
      );
  }
  if (
    input.data.assigneeId &&
    !(
      await tx.query(
        "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, input.data.assigneeId],
      )
    ).rows.length
  )
    throw new HttpError(400, "El responsable no pertenece al espacio.");
  if (
    input.kind === "sprint" &&
    input.data.status === "completed" &&
    existing?.data.status !== "completed"
  )
    throw new HttpError(400, "Usa la acción de cierre del sprint.");
  if (existing?.kind === "sprint" && existing.data.status === "completed")
    throw new HttpError(409, "El sprint cerrado conserva su estado histórico.");
  const data = { ...input.data };
  delete data.snapshot;
  delete data.closedAt;
  if (
    existing?.kind === "document" &&
    (
      await tx.query(
        "SELECT resource_id FROM document_states WHERE resource_id=$1",
        [existing.id],
      )
    ).rows.length
  )
    data.content = existing.data.content;
  const result = (
    await tx.query<Resource>(
      `INSERT INTO resources(id,workspace_id,kind,title,data,created_by,deleted_at)
        VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END)
        ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,data=CASE WHEN resources.kind='document' AND EXISTS(SELECT 1 FROM document_states WHERE resource_id=resources.id) THEN jsonb_set(EXCLUDED.data,'{content}',coalesce(resources.data->'content','null'::jsonb)) ELSE EXCLUDED.data END,version=resources.version+1,updated_at=now(),deleted_at=CASE WHEN $9::boolean THEN resources.deleted_at ELSE EXCLUDED.deleted_at END WHERE resources.workspace_id=EXCLUDED.workspace_id AND resources.version=$8 RETURNING *`,
      [
        input.id,
        workspaceId,
        input.kind,
        input.title,
        JSON.stringify(data),
        user.id,
        !!input.deleted,
        input.expectedVersion,
        !!(options.hierarchyMove && existing?.deleted_at && input.deleted),
      ],
    )
  ).rows[0];
  if (!result)
    throw new HttpError(
      409,
      "Hay cambios de otra persona. Recarga y revisa el elemento.",
    );
  if (
    !existing &&
    result.kind === "document" &&
    result.data.documentSeedVersion === 1
  ) {
    const seed = initialDocument(
      result.data.content || { type: "doc", content: [{ type: "paragraph" }] },
      result.id,
    );
    try {
      await tx.query(
        "INSERT INTO document_states(resource_id,state) VALUES($1,$2)",
        [result.id, Buffer.from(Y.encodeStateAsUpdate(seed))],
      );
    } finally {
      seed.destroy();
    }
  }
  const dashboardScopes =
    result.kind === "dashboard"
      ? dashboardHistoryScopes(result, all)
      : undefined;
  await tx.query(
    "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) VALUES($1,$2,$3,$4)",
    [
      result.id,
      result.version,
      JSON.stringify(
        result.kind === "dashboard"
          ? {
              ...result,
              data: {
                ...result.data,
                dashboardScopes,
              },
            }
          : result,
      ),
      user.id,
    ],
  );
  await tx.query(
    "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,$4)",
    [
      workspaceId,
      result.id,
      user.id,
      input.deleted ? "deleted" : existing ? "updated" : "created",
    ],
  );
  const response = {
    resource: result,
    command: "resource_mutation",
    ...(dashboardScopes ? { dashboardScopes } : {}),
  };
  await notifyChange(tx, result, existing, all, user.id);
  await cancelPendingReminder(tx, result);
  await enqueueTaskEvents(tx, result, existing, all, user.id);
  await captureSprintBaseline(tx, result, existing, all);
  if (!options.skipOperation)
    await tx.query(
      "INSERT INTO operations(id,workspace_id,user_id,response) VALUES($1,$2,$3,$4)",
      [input.operationId, workspaceId, user.id, JSON.stringify(response)],
    );
  return response;
}
