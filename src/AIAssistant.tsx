import { Field } from "./components/Primitives";
import { useState } from "react";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { api, send } from "./api";
import { kindLabels, type Resource } from "../shared/model";

export function AIView({ workspaceId, resources, error, create, open }: any) {
  const [selected, setSelected] = useState<string[]>([]),
    [prompt, setPrompt] = useState(""),
    [proposal, setProposal] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="ai-layout">
      <section>
        <h2>¿En qué avanzamos?</h2>
        <p className="muted">
          Elige el contexto y pide un resumen, un plan o una propuesta. Tú
          decides qué se guarda.
        </p>
        <div className="ai-suggestions">
          {[
            "Resume el estado del proyecto y sus bloqueos.",
            "Propón tareas con criterios de aceptación.",
            "Prepara un objetivo y un plan para el próximo sprint.",
          ].map((text) => (
            <button key={text} onClick={() => setPrompt(text)}>
              {text}
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setProposal(
                (
                  await api(
                    `/workspaces/${workspaceId}/ai/generate`,
                    send({ prompt, resourceIds: selected }),
                  )
                ).proposal,
              );
            } catch (e) {
              error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Tu solicitud">
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </Field>
          <p className="muted">
            Se enviarán tu solicitud y {selected.length} elementos al proveedor
            configurado.
          </p>
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Sparkles size={16} />
            )}
            Generar propuesta
          </button>
        </form>
        {proposal && (
          <section className="ai-proposal">
            <h2>Propuesta para revisar</h2>
            <pre>{proposal}</pre>
            <button
              onClick={async () => {
                const r = await create("document", "Propuesta del asistente", {
                  description: proposal,
                  content: {
                    type: "doc",
                    content: proposal.split("\n").map((line) => ({
                      type: "paragraph",
                      ...(line
                        ? { content: [{ type: "text", text: line }] }
                        : {}),
                    })),
                  },
                });
                if (r) open(r);
              }}
            >
              Guardar como documento
            </button>
          </section>
        )}
      </section>
      <aside className="ai-context">
        <h2>Contexto seleccionado</h2>
        <p className="muted">Solo se enviarán los elementos marcados.</p>
        {resources
          .filter((r: Resource) =>
            ["project", "document", "task", "sprint"].includes(r.kind),
          )
          .map((r: Resource) => (
            <label className="checklist-item" key={r.id}>
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, r.id]
                      : selected.filter((id) => id !== r.id),
                  )
                }
              />
              <span>
                <small>{kindLabels[r.kind]}</small>
                {r.title}
              </span>
            </label>
          ))}
      </aside>
    </div>
  );
}
