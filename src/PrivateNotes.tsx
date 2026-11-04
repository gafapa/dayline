import { useMemo, useState } from "react";
import type { Resource, User, Workspace } from "../shared/model";
import { useSprintDraft } from "./useSprintDraft";
import { useLocalGuard } from "./useLocalGuard";
import { Field } from "./components/Primitives";

type Draft = { id: string; title: string; summary: string };
const blank = (): Draft => ({
  id: crypto.randomUUID(),
  title: "",
  summary: "",
});
export default function PrivateNotes({
  resources,
  user,
  workspace,
  canEdit,
  save,
  open,
}: {
  resources: Resource[];
  user: User;
  workspace: Workspace;
  canEdit: boolean;
  save: (resource: Resource) => Promise<Resource | undefined>;
  open: (resource: Resource) => void;
}) {
  const [value, setValue] = useState(blank),
    [composing, setComposing] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [limit, setLimit] = useState(50);
  useLocalGuard(
    busy ? "Espera a que termine la operación de la nota personal." : "",
  );
  const draft = useSprintDraft(
    user.id,
    `${workspace.id}:personal-note:new`,
    value,
    dirty,
    (saved) => {
      if (
        !saved ||
        typeof saved.id !== "string" ||
        typeof saved.title !== "string" ||
        typeof saved.summary !== "string"
      )
        throw new Error("Invalid personal note draft");
      setValue(saved);
      setDirty(true);
      setComposing(true);
    },
  );
  const notes = useMemo(
    () =>
      resources
        .filter(
          (resource) =>
            resource.kind === "document" &&
            resource.data.personalNote &&
            resource.data.ownerId === user.id &&
            !resource.deleted_at &&
            (!resource.data.archived || archived) &&
            `${resource.title} ${resource.data.description || ""}`
              .toLocaleLowerCase("es")
              .includes(query.trim().toLocaleLowerCase("es")),
        )
        .sort(
          (a, b) =>
            b.updated_at.localeCompare(a.updated_at) ||
            a.id.localeCompare(b.id),
        ),
    [resources, user.id, query, archived],
  );
  const patch = (update: Partial<Draft>) => {
    setValue((previous) => ({ ...previous, ...update }));
    setDirty(true);
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportDraft = () => {
    const link = document.createElement("a"),
      url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              { type: "personal-note-draft", schemaVersion: 1, value },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
    link.href = url;
    link.download = "nota-personal-borrador.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const create = () =>
    perform(async () => {
      if (!canEdit || !value.title.trim()) return;
      const saved = await save({
        id: value.id,
        workspace_id: workspace.id,
        kind: "document",
        title: value.title.trim(),
        data: {
          personalNote: true,
          ownerId: user.id,
          description: value.summary,
          content: { type: "doc", content: [{ type: "paragraph" }] },
        },
        version: 0,
        created_by: user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      });
      if (!saved)
        throw new Error("No se pudo guardar la nota. El borrador se conserva.");
      await draft.clear();
      setDirty(false);
      setValue(blank());
      setComposing(false);
      open(saved);
    });
  return (
    <div className="private-notes">
      <div className="notes-intro">
        <p>
          Notas personales de este espacio. Solo tu cuenta puede consultarlas en
          la aplicación.
        </p>
        {canEdit && (
          <button className="primary" onClick={() => setComposing(true)}>
            Nueva nota personal
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {draft.issue && <p role="alert">{draft.issue}</p>}
      {composing && (
        <section className="notes-composer" aria-label="Crear nota personal">
          <h2>Una idea para ti</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <fieldset disabled={!canEdit || !draft.ready || busy}>
              <Field label="Título de la nota">
                <input
                  required
                  maxLength={500}
                  value={value.title}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </Field>
              <Field label="Resumen de la nota">
                <textarea
                  rows={3}
                  maxLength={100000}
                  value={value.summary}
                  onChange={(event) => patch({ summary: event.target.value })}
                />
              </Field>
              <p>
                Al abrirla tendrás el editor completo. Esta nota conservará su
                privacidad al editarla o restaurarla.
              </p>
            </fieldset>
            <div className="notes-actions">
              {canEdit && (
                <button
                  className="primary"
                  disabled={!draft.ready || busy || !value.title.trim()}
                >
                  Crear nota personal
                </button>
              )}
              <button type="button" onClick={exportDraft}>
                Exportar borrador de nota
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await draft.clear();
                    setDirty(false);
                    setValue(blank());
                    setComposing(false);
                  })
                }
              >
                Descartar borrador de nota
              </button>
            </div>
            <p role="status">
              {draft.saved
                ? "Borrador de nota guardado en este dispositivo."
                : dirty
                  ? "Borrador pendiente de guardar en este dispositivo."
                  : ""}
            </p>
          </form>
        </section>
      )}
      <section className="notes-filters" aria-label="Filtros de notas">
        <Field label="Buscar por título o resumen">
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(50);
            }}
          />
        </Field>
        <label className="notes-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              setLimit(50);
            }}
          />
          Incluir notas archivadas
        </label>
      </section>
      <p className="muted" role="status">
        {notes.length}{" "}
        {notes.length === 1 ? "nota personal" : "notas personales"}
      </p>
      <section className="notes-list" aria-label="Mis notas personales">
        {notes.slice(0, limit).map((note) => (
          <article key={note.id} className="notes-row">
            <div>
              <button className="text-button" onClick={() => open(note)}>
                {note.title}
              </button>
              <p>
                {note.data.description
                  ? note.data.description.slice(0, 320) +
                    (note.data.description.length > 320 ? "…" : "")
                  : "Sin resumen"}
              </p>
              <small>
                Solo tu cuenta · Actualizada{" "}
                {new Date(note.updated_at).toLocaleDateString("es", {
                  dateStyle: "medium",
                })}
                {note.data.archived ? " · Archivada" : ""}
              </small>
            </div>
            {canEdit && (
              <button
                className="text-button"
                aria-label={`${note.data.archived ? "Desarchivar" : "Archivar"} ${note.title}`}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await save({
                      ...note,
                      data: { ...note.data, archived: !note.data.archived },
                    });
                  })
                }
              >
                {note.data.archived ? "Desarchivar" : "Archivar"}
              </button>
            )}
          </article>
        ))}
        {!notes.length && (
          <p>
            {query || archived
              ? "No hay notas para estos filtros."
              : "Todavía no tienes notas personales en este espacio."}
          </p>
        )}
      </section>
      {notes.length > limit && (
        <button onClick={() => setLimit((previous) => previous + 50)}>
          Mostrar 50 notas más
        </button>
      )}
    </div>
  );
}
