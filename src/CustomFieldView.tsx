import { useState } from "react";
import { Field } from "./components/Primitives";
import { CustomFieldInput } from "./CustomFieldInputs";
import {
  fieldOperatorLabels,
  fieldFilterError,
  fieldValueLabel,
  type FieldDefinition,
  type FieldFilter,
  type FieldReference,
  type CustomFieldValue,
} from "../shared/custom-fields";
import type { Resource } from "../shared/model";
export function CustomFieldViewControls({
  projects,
  members,
  filters,
  columns,
  change,
}: {
  projects: Resource[];
  members: { id: string; name: string }[];
  filters: FieldFilter[];
  columns: FieldReference[];
  change: (filters: FieldFilter[], columns: FieldReference[]) => void;
}) {
  const [projectId, setProjectId] = useState(""),
    [fieldId, setFieldId] = useState(""),
    [operator, setOperator] = useState<FieldFilter["operator"]>("is"),
    [value, setValue] = useState<CustomFieldValue>(null);
  const available = projects.filter((p) => p.data.fieldDefinitions?.length),
    project = available.find((p) => p.id === projectId),
    definitions: FieldDefinition[] = project?.data.fieldDefinitions || [],
    field = definitions.find((f) => f.id === fieldId);
  if (!available.length && !filters.length && !columns.length) return null;
  const filter = { projectId, fieldId, operator, value },
    issue = field ? fieldFilterError(field, filter) : "Elige un campo.";
  const operators: FieldFilter["operator"][] = field
    ? [
        "is",
        "is_not",
        "empty",
        "not_empty",
        ...(["text", "multiselect"].includes(field.type)
          ? ["contains" as const]
          : []),
        ...(["number", "date"].includes(field.type)
          ? ["gt" as const, "gte" as const, "lt" as const, "lte" as const]
          : []),
      ]
    : [];
  const label = (reference: FieldReference) => {
    const project = projects.find((p) => p.id === reference.projectId),
      definition = project?.data.fieldDefinitions?.find(
        (f: FieldDefinition) => f.id === reference.fieldId,
      );
    return `${project?.title || "Proyecto no disponible"} · ${definition?.name || "Campo no disponible"}`;
  };
  return (
    <details className="custom-view-controls">
      <summary>Filtros y propiedades del proyecto</summary>
      <div className="collection-filters">
        <Field label="Proyecto del campo">
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setFieldId("");
              setValue(null);
              setOperator("is");
            }}
          >
            <option value="">Elige un proyecto</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Campo de la vista">
          <select
            value={fieldId}
            onChange={(e) => {
              setFieldId(e.target.value);
              setValue(null);
              setOperator("is");
            }}
          >
            <option value="">Elige un campo</option>
            {definitions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.archived ? " (archivado)" : ""}
              </option>
            ))}
          </select>
        </Field>
        {field && (
          <>
            <Field label="Condición del campo">
              <select
                value={operator}
                onChange={(e) => {
                  setOperator(e.target.value as FieldFilter["operator"]);
                  setValue(null);
                }}
              >
                {operators.map((op) => (
                  <option key={op} value={op}>
                    {fieldOperatorLabels[op]}
                  </option>
                ))}
              </select>
            </Field>
            {!["empty", "not_empty"].includes(operator) && (
              <CustomFieldInput
                field={{
                  ...field,
                  archived: false,
                  required: false,
                  options: field.options.map((option) => ({
                    ...option,
                    archived: false,
                  })),
                  type:
                    operator === "contains" && field.type === "multiselect"
                      ? "select"
                      : field.type,
                }}
                label="Valor del filtro"
                value={value}
                change={setValue}
                members={members}
              />
            )}
            <div className="custom-view-actions">
              <button
                type="button"
                disabled={!!issue || filters.length >= 20}
                onClick={() => change([...filters, filter], columns)}
              >
                Añadir condición
              </button>
              <button
                type="button"
                disabled={
                  columns.length >= 8 ||
                  columns.some(
                    (c) => c.projectId === projectId && c.fieldId === fieldId,
                  )
                }
                onClick={() =>
                  change(filters, [...columns, { projectId, fieldId }])
                }
              >
                Mostrar propiedad
              </button>
            </div>
            {issue && <p className="muted">{issue}</p>}
          </>
        )}
      </div>
      <p className="muted">
        Las condiciones se cumplen juntas y limitan los resultados al proyecto
        del campo.
      </p>
      <ul className="custom-view-selection">
        {filters.map((f, index) => (
          <li key={index}>
            <span>
              {label(f)} · {fieldOperatorLabels[f.operator]}
              {!["empty", "not_empty"].includes(f.operator)
                ? ` · ${fieldValueLabel(projects.find((p) => p.id === f.projectId)?.data.fieldDefinitions?.find((d: FieldDefinition) => d.id === f.fieldId) || { type: "text" }, f.value, members)}`
                : ""}
            </span>
            <button
              type="button"
              aria-label={`Quitar condición ${index + 1}`}
              onClick={() =>
                change(
                  filters.filter((_, i) => i !== index),
                  columns,
                )
              }
            >
              Quitar
            </button>
          </li>
        ))}
      </ul>
      <ul className="custom-view-selection">
        {columns.map((c, index) => (
          <li key={`${c.projectId}:${c.fieldId}`}>
            <span>Propiedad visible: {label(c)}</span>
            <button
              type="button"
              aria-label={`Ocultar propiedad ${index + 1}`}
              onClick={() =>
                change(
                  filters,
                  columns.filter((_, i) => i !== index),
                )
              }
            >
              Ocultar
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
export function TaskCustomFieldValues({
  task,
  projects,
  members,
  columns,
}: {
  task: Resource;
  projects: Resource[];
  members: { id: string; name: string }[];
  columns: FieldReference[];
}) {
  const visible = columns
    .filter((c) => c.projectId === task.data.projectId)
    .map((c) =>
      projects
        .find((p) => p.id === c.projectId)
        ?.data.fieldDefinitions?.find(
          (f: FieldDefinition) => f.id === c.fieldId,
        ),
    )
    .filter(Boolean) as FieldDefinition[];
  if (!visible.length) return null;
  return (
    <span className="task-custom-values">
      {visible.map((field) => (
        <span key={field.id}>
          <span className="muted">{field.name}: </span>
          {fieldValueLabel(field, task.data.customFields?.[field.id], members)}
        </span>
      ))}
    </span>
  );
}
