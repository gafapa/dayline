import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Connection } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import {
  fieldDefinitionsSchema,
  snapshotField,
  fieldValueError,
  applyFieldDefaults,
  emptyFieldValue,
  type FieldDefinition,
  type FieldSnapshot,
} from "../shared/custom-fields.js";
import { HttpError } from "./errors.js";
export type FieldOptions = {
  fieldAdministration?: boolean;
  trustedFieldSnapshots?: boolean;
  fieldMembers?: Set<string>;
};
export const canManageFields = (
  project: Resource,
  userId: string,
  role: Role,
) => role !== "viewer" && (role === "admin" || project.created_by === userId);
export function checkDefinitions(
  definitions: FieldDefinition[],
  previous: FieldDefinition[],
  members: Set<string>,
) {
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const field of definitions) {
    if (
      ids.has(field.id) ||
      (!field.archived && names.has(field.name.toLocaleLowerCase()))
    )
      throw new HttpError(
        400,
        "Los campos necesitan identificadores y nombres activos únicos.",
      );
    ids.add(field.id);
    if (!field.archived) names.add(field.name.toLocaleLowerCase());
    const old = previous.find((f) => f.id === field.id);
    if (old && old.type !== field.type)
      throw new HttpError(
        409,
        "El tipo de un campo guardado no cambia. Archívalo y crea otro campo.",
      );
    if (
      ((field.min !== undefined || field.max !== undefined) &&
        field.type !== "number") ||
      (field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max)
    )
      throw new HttpError(400, "Los límites del campo no son válidos.");
    if (!["select", "multiselect"].includes(field.type) && field.options.length)
      throw new HttpError(400, "Este tipo de campo no admite opciones.");
    if (
      new Set(field.options.map((o) => o.id)).size !== field.options.length ||
      new Set(
        field.options
          .filter((o) => !o.archived)
          .map((o) => o.label.toLocaleLowerCase()),
      ).size !== field.options.filter((o) => !o.archived).length
    )
      throw new HttpError(
        400,
        "Las opciones activas necesitan nombres e identificadores únicos.",
      );
    if (old?.options.some((o) => !field.options.some((n) => n.id === o.id)))
      throw new HttpError(
        409,
        "Archiva las opciones para conservar sus valores e historial.",
      );
    if (field.defaultValue !== undefined) {
      const issue = fieldValueError(
        { ...field, required: false },
        field.defaultValue,
        members,
      );
      if (issue)
        throw new HttpError(
          400,
          `Valor predeterminado de ${field.name}: ${issue}`,
        );
    }
  }
  if (previous.some((field) => !ids.has(field.id)))
    throw new HttpError(
      409,
      "Archiva los campos para conservar sus valores e historial.",
    );
}
export function defaultTaskFields(
  data: Record<string, any>,
  definitions: FieldDefinition[],
  mode: "create" | "required" | "missing" = "create",
): Record<string, any> {
  return {
    ...data,
    customFields: applyFieldDefaults(
      data.customFields || {},
      definitions,
      mode,
    ),
  };
}
export async function validateCustomFieldData(
  tx: Connection,
  proposed: Resource,
  existing: Resource | undefined,
  all: Resource[],
  user: User,
  role: Role,
  options: FieldOptions = {},
) {
  const data = structuredClone(proposed.data);
  if (proposed.kind !== "project" && data.fieldDefinitions !== undefined)
    throw new HttpError(400, "Las definiciones pertenecen a un proyecto.");
  if (proposed.kind !== "task" && data.fieldSnapshots !== undefined)
    throw new HttpError(
      400,
      "Los valores configurados pertenecen a una tarea.",
    );
  if (proposed.kind === "project") {
    const definitions = fieldDefinitionsSchema.parse(
        data.fieldDefinitions || [],
      ),
      previous = fieldDefinitionsSchema.parse(
        existing?.data.fieldDefinitions || [],
      );
    if (!isDeepStrictEqual(definitions, previous)) {
      if (!canManageFields(existing || proposed, user.id, role))
        throw new HttpError(
          403,
          "Solo la administración o la persona que creó el proyecto puede configurar campos.",
        );
      if (existing && !options.fieldAdministration)
        throw new HttpError(
          409,
          "Usa la configuración de campos para revisar este cambio.",
        );
      const members =
        options.fieldMembers ||
        new Set<string>(
          (
            await tx.query(
              "SELECT user_id FROM memberships WHERE workspace_id=$1",
              [proposed.workspace_id],
            )
          ).rows.map((r) => r.user_id),
        );
      checkDefinitions(definitions, previous, members);
      for (const task of all.filter(
        (r) =>
          r.kind === "task" &&
          r.data.projectId === proposed.id &&
          !r.deleted_at,
      )) {
        const values = defaultTaskFields(
          task.data,
          definitions,
          task.version > 0 ? "required" : "create",
        ).customFields;
        for (const field of definitions)
          if (
            !field.archived &&
            fieldValueError(field, values[field.id], undefined, true)
          )
            throw new HttpError(
              409,
              "La configuración no es compatible con todos los valores guardados. Revisa los límites y los campos obligatorios.",
            );
      }
    }
    if (data.fieldDefinitions !== undefined)
      data.fieldDefinitions = definitions;
    return data;
  }
  if (proposed.kind !== "task") return data;
  const project = all.find(
      (r) => r.id === data.projectId && r.kind === "project",
    ),
    definitions = fieldDefinitionsSchema.parse(
      project?.data.fieldDefinitions || [],
    ),
    oldSnapshots: FieldSnapshot[] = existing?.data.fieldSnapshots || [];
  if (
    data.fieldSnapshots !== undefined &&
    !options.trustedFieldSnapshots &&
    !isDeepStrictEqual(data.fieldSnapshots, oldSnapshots)
  )
    throw new HttpError(
      400,
      "Los metadatos de campos se conservan desde el servidor.",
    );
  const snapshots: FieldSnapshot[] = options.trustedFieldSnapshots
    ? data.fieldSnapshots || []
    : oldSnapshots;
  const normalized = proposed.deleted_at
      ? data
      : defaultTaskFields(data, definitions, existing ? "required" : "create"),
    values = normalized.customFields || {},
    oldValues = existing?.data.customFields || {};
  if (Object.keys(values).length > 100)
    throw new HttpError(
      400,
      "Cada tarea admite hasta 100 valores personalizados.",
    );
  const members = definitions.some((f) => f.type === "person")
    ? options.fieldMembers ||
      new Set<string>(
        (
          await tx.query(
            "SELECT user_id FROM memberships WHERE workspace_id=$1",
            [proposed.workspace_id],
          )
        ).rows.map((r) => r.user_id),
      )
    : undefined;
  for (const field of definitions) {
    const unchanged = isDeepStrictEqual(values[field.id], oldValues[field.id]);
    if (field.archived && !unchanged && !options.trustedFieldSnapshots)
      throw new HttpError(409, "Los campos archivados conservan sus valores.");
    if (proposed.deleted_at || field.archived) continue;
    const issue = fieldValueError(
      field,
      values[field.id],
      unchanged ? undefined : members,
      unchanged,
    );
    if (issue) throw new HttpError(400, `${field.name}: ${issue}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (definitions.some((f) => f.id === key)) continue;
    const snapshot = snapshots.find((f) => f.id === key);
    if (snapshot) {
      if (
        !options.trustedFieldSnapshots &&
        !isDeepStrictEqual(value, oldValues[key])
      )
        throw new HttpError(
          409,
          "El valor del proyecto de origen se conserva sin cambios. Puedes quitarlo o mover la tarea a un proyecto compatible.",
        );
      if (
        fieldValueError(
          { ...snapshot, required: false },
          value,
          undefined,
          true,
        )
      )
        throw new HttpError(
          400,
          "El campo conservado no tiene un valor válido.",
        );
    } else if (
      z.string().uuid().safeParse(key).success &&
      !Object.hasOwn(oldValues, key)
    )
      throw new HttpError(400, "El campo no está definido en este proyecto.");
    else if (Array.isArray(value))
      throw new HttpError(
        400,
        "La selección múltiple requiere un campo configurado.",
      );
  }
  normalized.fieldSnapshots = [
    ...snapshots
      .filter(
        (f) =>
          Object.hasOwn(values, f.id) &&
          !definitions.some((d) => d.id === f.id),
      )
      .map((field) =>
        snapshotField(field, values[field.id], field.sourceProjectId),
      ),
    ...definitions
      .filter((f) => Object.hasOwn(values, f.id))
      .map((f) => snapshotField(f, values[f.id], project?.id || null)),
  ];
  if (!normalized.fieldSnapshots.length) delete normalized.fieldSnapshots;
  return normalized;
}
