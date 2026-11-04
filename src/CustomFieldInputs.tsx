import { Field } from "./components/Primitives";
import {
  fieldValueLabel,
  type CustomFieldValue,
  type FieldDefinition,
} from "../shared/custom-fields";
export function CustomFieldInput({
  field,
  value,
  change,
  editable = true,
  members = [],
  label,
  required = false,
}: {
  field: FieldDefinition;
  value: CustomFieldValue | undefined;
  change: (value: CustomFieldValue) => void;
  editable?: boolean;
  members?: { id: string; name: string }[];
  label?: string;
  required?: boolean;
}) {
  const disabled = !editable || field.archived;
  const choices = field.options.filter(
    (o) =>
      !o.archived ||
      o.id === value ||
      (Array.isArray(value) && value.includes(o.id)),
  );
  let control;
  if (field.type === "boolean")
    control = (
      <select
        disabled={disabled}
        value={value === true ? "true" : value === false ? "false" : ""}
        required={required && field.required}
        onChange={(e) =>
          change(e.target.value === "" ? null : e.target.value === "true")
        }
      >
        <option value="">Sin valor</option>
        <option value="true">Sí</option>
        <option value="false">No</option>
      </select>
    );
  else if (field.type === "select" || field.type === "multiselect")
    control = (
      <select
        disabled={disabled}
        multiple={field.type === "multiselect"}
        value={
          field.type === "multiselect"
            ? Array.isArray(value)
              ? value
              : []
            : typeof value === "string"
              ? value
              : ""
        }
        required={required && field.required}
        onChange={(e) =>
          change(
            field.type === "multiselect"
              ? [...e.target.selectedOptions].map((o) => o.value)
              : e.target.value || null,
          )
        }
      >
        {field.type === "select" && <option value="">Sin valor</option>}
        {choices.map((option) => (
          <option key={option.id} value={option.id} disabled={option.archived}>
            {option.label}
            {option.archived ? " (archivada)" : ""}
          </option>
        ))}
      </select>
    );
  else if (field.type === "person")
    control = (
      <select
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        required={required && field.required}
        onChange={(e) => change(e.target.value || null)}
      >
        <option value="">Sin persona</option>
        {typeof value === "string" && !members.some((m) => m.id === value) && (
          <option value={value}>Persona no disponible</option>
        )}
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  else
    control = (
      <input
        type={
          field.type === "number"
            ? "number"
            : field.type === "date"
              ? "date"
              : field.type === "url"
                ? "url"
                : "text"
        }
        readOnly={disabled}
        min={field.type === "number" ? field.min : undefined}
        max={field.type === "number" ? field.max : undefined}
        step={field.type === "number" ? "any" : undefined}
        maxLength={field.maxLength}
        value={value === undefined || value === null ? "" : String(value)}
        required={required && field.required}
        onChange={(e) =>
          change(
            e.target.value === ""
              ? null
              : field.type === "number"
                ? Number(e.target.value)
                : e.target.value,
          )
        }
      />
    );
  return (
    <Field
      label={
        label ||
        `${field.name}${field.required && !field.archived ? " · Obligatorio" : ""}${field.archived ? " · Archivado" : ""}`
      }
    >
      {control}
    </Field>
  );
}
export function ConfiguredTaskFields({
  definitions,
  values,
  change,
  editable,
  members,
  required = false,
  sectionLabel = "Campos del proyecto",
}: {
  definitions: FieldDefinition[];
  values: Record<string, CustomFieldValue>;
  change: (values: Record<string, CustomFieldValue>) => void;
  editable: boolean;
  members: { id: string; name: string }[];
  required?: boolean;
  sectionLabel?: string;
}) {
  if (!definitions.length) return null;
  return (
    <section className="configured-fields" aria-label={sectionLabel}>
      <h3>{sectionLabel}</h3>
      {definitions
        .filter((field) => !field.archived || Object.hasOwn(values, field.id))
        .map((field) => (
          <div key={field.id} className="configured-field">
            <CustomFieldInput
              field={field}
              value={values[field.id]}
              change={(value) => change({ ...values, [field.id]: value })}
              editable={editable}
              members={members}
              required={required}
            />
            {field.description && <p className="muted">{field.description}</p>}
            {!editable && field.type === "multiselect" && (
              <p>{fieldValueLabel(field, values[field.id], members)}</p>
            )}
          </div>
        ))}
    </section>
  );
}
