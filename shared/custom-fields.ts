import { z } from "zod";
import { validDay } from "./time.js";
export const fieldTypes = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
  "multiselect",
  "url",
  "person",
] as const;
export const fieldTypeLabels: Record<(typeof fieldTypes)[number], string> = {
  text: "Texto",
  number: "Número",
  boolean: "Sí / No",
  date: "Fecha",
  select: "Selección",
  multiselect: "Selección múltiple",
  url: "Enlace",
  person: "Persona",
};
const id = z.string().uuid();
export const customFieldValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.array(id).max(50),
  z.null(),
]);
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;
export const fieldDefinitionSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(80),
    type: z.enum(fieldTypes),
    description: z.string().max(500).default(""),
    required: z.boolean().default(false),
    archived: z.boolean().default(false),
    options: z
      .array(
        z
          .object({
            id,
            label: z.string().trim().min(1).max(100),
            archived: z.boolean().default(false),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    maxLength: z.number().int().min(1).max(500).default(500),
    defaultValue: customFieldValueSchema.optional(),
  })
  .strict();
export const fieldDefinitionsSchema = z.array(fieldDefinitionSchema).max(50);
export const fieldSnapshotsSchema = z
  .array(fieldDefinitionSchema.extend({ sourceProjectId: id.nullable() }))
  .max(100);
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
export type FieldSnapshot = z.infer<typeof fieldSnapshotsSchema>[number];
export function snapshotField(
  field: FieldDefinition,
  value: unknown,
  sourceProjectId: string | null,
): FieldSnapshot {
  const { defaultValue: _defaultValue, ...definition } = field;
  const selected = new Set(Array.isArray(value) ? value : [value]);
  return {
    ...definition,
    description: "",
    options: field.options.filter((option) => selected.has(option.id)),
    sourceProjectId,
  };
}
export function emptyFieldValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  );
}
export function fieldValueError(
  field: FieldDefinition,
  value: unknown,
  members?: Set<string>,
  allowArchivedOptions = false,
): string | null {
  if (emptyFieldValue(value))
    return field.required && !field.archived
      ? "Este campo es obligatorio."
      : null;
  switch (field.type) {
    case "text":
      return typeof value === "string" && value.length <= field.maxLength
        ? null
        : `Usa texto de hasta ${field.maxLength} caracteres.`;
    case "number":
      return typeof value === "number" &&
        Number.isFinite(value) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
        ? null
        : "El número no cumple los límites del campo.";
    case "boolean":
      return typeof value === "boolean" ? null : "Elige Sí o No.";
    case "date":
      return typeof value === "string" && validDay(value)
        ? null
        : "Usa una fecha válida.";
    case "url":
      try {
        const url = new URL(String(value));
        return typeof value === "string" &&
          ["http:", "https:"].includes(url.protocol)
          ? null
          : "Usa un enlace HTTP o HTTPS.";
      } catch {
        return "Usa un enlace HTTP o HTTPS.";
      }
    case "person":
      return typeof value === "string" &&
        id.safeParse(value).success &&
        (!members || members.has(value))
        ? null
        : "La persona debe pertenecer al espacio.";
    case "select":
      return typeof value === "string" &&
        field.options.some(
          (o) => o.id === value && (allowArchivedOptions || !o.archived),
        )
        ? null
        : "Elige una opción activa del campo.";
    case "multiselect":
      return Array.isArray(value) &&
        new Set(value).size === value.length &&
        value.every(
          (v) =>
            typeof v === "string" &&
            field.options.some(
              (o) => o.id === v && (allowArchivedOptions || !o.archived),
            ),
        )
        ? null
        : "Elige opciones activas sin repetir.";
  }
}
export function fieldDefaults(
  definitions: FieldDefinition[],
): Record<string, CustomFieldValue> {
  return Object.fromEntries(
    definitions
      .filter((f) => !f.archived && f.defaultValue !== undefined)
      .map((f) => [f.id, structuredClone(f.defaultValue!)]),
  );
}
export function applyFieldDefaults(
  values: Record<string, CustomFieldValue>,
  definitions: FieldDefinition[],
  mode: "create" | "required" | "missing" = "create",
) {
  const result = { ...values };
  for (const field of definitions) {
    if (field.archived || field.defaultValue === undefined) continue;
    if (
      (mode === "create" && !Object.hasOwn(result, field.id)) ||
      ((field.required || mode === "missing") &&
        emptyFieldValue(result[field.id]))
    )
      result[field.id] = structuredClone(field.defaultValue);
  }
  return result;
}
export function fieldValueLabel(
  field: FieldDefinition,
  value: unknown,
  members: { id: string; name: string }[] = [],
): string {
  if (emptyFieldValue(value)) return "Sin valor";
  if (field.type === "boolean") return value ? "Sí" : "No";
  if (field.type === "select" || field.type === "multiselect")
    return (Array.isArray(value) ? value : [value])
      .map(
        (v) =>
          field.options.find((o) => o.id === v)?.label ||
          "Opción no disponible",
      )
      .join(", ");
  if (field.type === "person")
    return members.find((m) => m.id === value)?.name || "Persona no disponible";
  return String(value);
}
export const fieldReferenceSchema = z
  .object({ projectId: id, fieldId: id })
  .strict();
export const fieldFilterSchema = fieldReferenceSchema
  .extend({
    operator: z.enum([
      "is",
      "is_not",
      "contains",
      "empty",
      "not_empty",
      "gt",
      "gte",
      "lt",
      "lte",
    ]),
    value: customFieldValueSchema.optional(),
  })
  .strict();
export type FieldFilter = z.infer<typeof fieldFilterSchema>;
export type FieldReference = z.infer<typeof fieldReferenceSchema>;
export const fieldOperatorLabels: Record<FieldFilter["operator"], string> = {
  is: "Es igual a",
  is_not: "Es distinto de",
  contains: "Contiene",
  empty: "Sin valor",
  not_empty: "Con valor",
  gt: "Mayor que",
  gte: "Mayor o igual",
  lt: "Menor que",
  lte: "Menor o igual",
};
export function fieldFilterError(
  field: FieldDefinition,
  filter: FieldFilter,
): string | null {
  if (filter.operator === "empty" || filter.operator === "not_empty")
    return null;
  if (
    ["gt", "gte", "lt", "lte"].includes(filter.operator) &&
    !["number", "date"].includes(field.type)
  )
    return "Este campo no admite comparaciones de orden.";
  if (filter.operator === "contains") {
    if (field.type === "text")
      return typeof filter.value === "string" && filter.value.length > 0
        ? null
        : "Escribe el texto que quieres buscar.";
    if (field.type === "multiselect")
      return typeof filter.value === "string" &&
        field.options.some((o) => o.id === filter.value)
        ? null
        : "Elige una opción del campo.";
    return "Este campo no admite Contiene.";
  }
  return fieldValueError(
    { ...field, required: true, archived: false },
    filter.value,
    undefined,
    true,
  );
}
export function matchesFieldFilter(
  task: { data: Record<string, any> },
  filter: FieldFilter,
) {
  if (task.data.projectId !== filter.projectId) return false;
  const value = task.data.customFields?.[filter.fieldId];
  if (filter.operator === "empty") return emptyFieldValue(value);
  if (filter.operator === "not_empty") return !emptyFieldValue(value);
  if (filter.operator === "contains")
    return Array.isArray(value)
      ? value.includes(filter.value)
      : typeof value === "string" &&
          typeof filter.value === "string" &&
          value.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
  if (["gt", "gte", "lt", "lte"].includes(filter.operator)) {
    if (
      emptyFieldValue(value) ||
      emptyFieldValue(filter.value) ||
      typeof value !== typeof filter.value ||
      !["string", "number"].includes(typeof value)
    )
      return false;
    const a = value as string | number,
      b = filter.value as string | number;
    return filter.operator === "gt"
      ? a > b
      : filter.operator === "gte"
        ? a >= b
        : filter.operator === "lt"
          ? a < b
          : a <= b;
  }
  const canonical = (input: unknown) =>
    JSON.stringify(Array.isArray(input) ? [...input].sort() : input);
  const equal = canonical(value) === canonical(filter.value);
  return filter.operator === "is" ? equal : !equal;
}
