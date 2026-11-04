import { useMemo, useState, type ComponentType } from "react";
import { ArrowRight, CircleCheck, FileText, FolderKanban, Plus, Zap } from "lucide-react";
import { Modal } from "./components/Primitives";
import type { Resource } from "../shared/model";
import { kindLabels } from "../shared/model";
import { documentText } from "../shared/documents";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon?: ComponentType<{ size?: number }>;
  run: () => void;
};
type Entry = PaletteAction & { group: string };

const fold = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** A short excerpt around the first match, for document results. */
function excerpt(text: string, query: string) {
  const at = fold(text).indexOf(fold(query));
  if (at < 0) return "";
  const start = Math.max(0, at - 40);
  return `${start ? "…" : ""}${text.slice(start, at + query.length + 60).trim()}…`;
}

/**
 * Ctrl K: one box to go anywhere, find any item and run actions from the keyboard.
 * Arrow keys move, Enter runs; a leading ">" lists actions only.
 */
export default function CommandPalette({
  resources,
  pages,
  actions,
  open,
  close,
}: {
  resources: Resource[];
  pages: PaletteAction[];
  actions: PaletteAction[];
  open: (resource: Resource) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const onlyActions = query.trimStart().startsWith(">");
  const term = fold(onlyActions ? query.trimStart().slice(1).trim() : query.trim());
  const entries = useMemo<Entry[]>(() => {
    const match = (text: string) => !term || fold(text).includes(term);
    const acts = actions.filter((a) => match(`${a.label} ${a.hint || ""}`)).map((a) => ({ ...a, group: "Acciones" }));
    if (onlyActions) return acts;
    const go = pages.filter((p) => match(p.label)).map((p) => ({ ...p, group: "Ir a" }));
    if (!term) return [...acts.slice(0, 4), ...go];
    const items = resources
      .filter((r) => !r.deleted_at && !["notification", "comment"].includes(r.kind))
      .map((r) => {
        const body = r.kind === "document" ? documentText(r.data.content) : r.data.description || "";
        const inTitle = fold(r.title).includes(term);
        return { r, body, inTitle, hit: inTitle || fold(body).includes(term) };
      })
      .filter((x) => x.hit)
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.r.updated_at.localeCompare(a.r.updated_at))
      .slice(0, 24)
      .map(({ r, body, inTitle }) => ({
        id: r.id,
        group: r.kind === "task" ? "Tareas" : r.kind === "document" ? "Documentos" : "Otros",
        label: r.title,
        hint: !inTitle && body ? excerpt(body, term) : kindLabels[r.kind],
        icon: r.kind === "task" ? CircleCheck : r.kind === "document" ? FileText : FolderKanban,
        run: () => open(r),
      }));
    return [...go, ...items, ...acts];
  }, [term, onlyActions, resources, pages, actions]);
  const current = Math.min(active, Math.max(0, entries.length - 1));
  const run = (entry?: Entry) => {
    if (!entry) return;
    close();
    entry.run();
  };
  let lastGroup = "";
  return (
    <Modal title="Buscar en tu espacio" close={close} className="command-dialog">
      <div className="palette-input">
        <label htmlFor="palette-query" className="sr-only">
          Buscar, ir a o ejecutar una acción
        </label>
        <input
          id="palette-query"
          autoFocus
          value={query}
          placeholder="Busca tareas y documentos, ve a una sección o escribe > para acciones"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={entries[current] ? `palette-${current}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, entries.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(entries[current]);
            }
          }}
        />
      </div>
      <div id="palette-results" className="command-results" role="listbox" aria-label="Resultados">
        {entries.map((entry, index) => {
          const heading = entry.group !== lastGroup ? entry.group : "";
          lastGroup = entry.group;
          const Icon = entry.icon || (entry.group === "Acciones" ? Zap : ArrowRight);
          return (
            <div key={`${entry.group}:${entry.id}`} role="presentation">
              {heading && <p className="palette-group">{heading}</p>}
              <button
                id={`palette-${index}`}
                role="option"
                aria-selected={index === current}
                className={index === current ? "active" : ""}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(entry)}
              >
                <Icon size={17} />
                <span className="palette-text">
                  <strong>{entry.label}</strong>
                  {entry.hint && <small>{entry.hint}</small>}
                </span>
                {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
              </button>
            </div>
          );
        })}
        {!entries.length && <p className="muted palette-empty">Sin resultados para «{query}».</p>}
      </div>
      <p className="palette-footer">
        <span>↑↓ moverse</span>
        <span>Intro abrir</span>
        <span>Esc cerrar</span>
        <span>
          <Plus size={12} /> «&gt;» solo acciones
        </span>
      </p>
    </Modal>
  );
}
