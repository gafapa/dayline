import { useState } from "react";
import { resourceHref } from "../shared/navigation";
import { Field } from "./components/Primitives";
export function ResourceLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false),
    [fallback, setFallback] = useState(false);
  const href = resourceHref(id, location.origin);
  return (
    <div className="resource-link">
      <button
        type="button"
        className="text-button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(href);
            setCopied(true);
            setFallback(false);
          } catch {
            setFallback(true);
          }
        }}
      >
        Copiar enlace
      </button>
      {copied && (
        <span role="status">
          Enlace copiado. Solo pueden abrirlo quienes tengan acceso.
        </span>
      )}
      {fallback && (
        <Field label="Enlace al elemento">
          <input
            readOnly
            value={href}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
      )}
    </div>
  );
}
