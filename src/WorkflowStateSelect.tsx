import type React from "react";
import type { Resource } from "../shared/model";
import {
  applyStateOption,
  optionValue,
  stateOptions,
} from "../shared/workflow";
import { statusLabels } from "../shared/task-status";

/** Task state choice grouped by category; returns data with both status and stateId. */
export default function WorkflowStateSelect({
  task,
  projects,
  onChange,
  disabled,
  className,
  label,
  ...rest
}: {
  task: Resource;
  projects: Resource[];
  onChange: (data: Record<string, any>) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
} & Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  "onChange" | "value" | "disabled" | "className"
>) {
  const project = projects.find(
      (p) => p.kind === "project" && p.id === task.data.projectId,
    ),
    options = stateOptions(project, task),
    named = options.some((o) => o.stateId);
  return (
    <select
      {...rest}
      className={className}
      aria-label={label}
      disabled={disabled}
      value={optionValue(task, projects)}
      onChange={(event) => {
        const option = options.find((o) => o.value === event.target.value);
        if (option) onChange(applyStateOption(task.data, option));
      }}
    >
      {named
        ? [...new Set(options.map((o) => o.category))].map((category) => (
            <optgroup key={category} label={statusLabels[category]}>
              {options
                .filter((o) => o.category === category)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))
        : options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
    </select>
  );
}
