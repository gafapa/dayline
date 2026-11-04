import { useEffect, useRef, useState } from "react";
import type { Resource, User, Workspace } from "../shared/model";
import {
  captureDraftSchema,
  buildCapturedResource,
  type CaptureDraft,
} from "../shared/capture";
import { fieldDefaults } from "../shared/custom-fields";
import { isStructure } from "../shared/hierarchy";
import { Field, Modal } from "./components/Primitives";
import { ConfiguredTaskFields } from "./CustomFieldInputs";
import { useSprintDraft } from "./useSprintDraft";
import { useLocalGuard } from "./useLocalGuard";

export default function QuickCapture({
  user,
  workspace,
  resources,
  members,
  initialDestination,
  save,
  open,
  close,
  online,
  canEdit,
}: {
  user: User;
  workspace: Workspace;
  resources: Resource[];
  members: { id: string; name: string }[];
  initialDestination: string | null;
  save: (resource: Resource) => Promise<Resource | undefined>;
  open: (resource: Resource) => void;
  close: () => void;
  online: boolean;
  canEdit: boolean;
}) {
  const fresh = (
    kind: CaptureDraft["kind"] = "private_note",
    destinationId = initialDestination || "",
  ): CaptureDraft => ({
    id: crypto.randomUUID(),
    kind,
    title: "",
    text: "",
    sourceUrl: "",
    destinationId,
    assignToMe: true,
    dueDate: "",
    customFields:
      kind === "task"
        ? fieldDefaults(
            resources.find((resource) => resource.id === destinationId)?.data
              .fieldDefinitions || [],
          )
        : {},
  });
  const [value, setValue] = useState(() => fresh()),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [locationQuery, setLocationQuery] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!busy && message.startsWith("«")) titleRef.current?.focus();
  }, [busy, message]);
  useLocalGuard(busy ? "Espera a que termine el guardado de la captura." : "");
  const draft = useSprintDraft(
    user.id,
    `${workspace.id}:quick-capture:new`,
    value,
    dirty,
    (snapshot) => {
      setValue(captureDraftSchema.parse(snapshot));
      setDirty(true);
    },
  );
  useEffect(() => {
    if (draft.ready && canEdit) titleRef.current?.focus();
  }, [draft.ready, canEdit]);
  const patch = (update: Partial<CaptureDraft>) => {
    setValue((before) => ({ ...before, ...update }));
    setDirty(true);
    setMessage("");
  };
  const destination = resources.find(
    (resource) => resource.id === value.destinationId,
  );
  const options = resources
    .filter(
      (resource) =>
        resource.workspace_id === workspace.id &&
        !resource.deleted_at &&
        !resource.data.archived &&
        (value.kind === "task"
          ? resource.kind === "project"
          : isStructure(resource)) &&
        (resource.id === value.destinationId ||
          resource.title
            .toLocaleLowerCase("es")
            .includes(locationQuery.toLocaleLowerCase("es"))),
    )
    .sort(
      (a, b) =>
        Number(b.id === value.destinationId) -
        Number(a.id === value.destinationId),
    )
    .slice(0, 50);
  const requestClose = () => {
    if (busy) return;
    if (dirty && !draft.saved) {
      setError(
        "El borrador aún no está confirmado en este dispositivo. Espera a que se guarde o expórtalo antes de cerrar.",
      );
      return;
    }
    close();
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
  const submit = (andOpen: boolean) =>
    perform(async () => {
      if (!canEdit)
        throw new Error(
          "Tu acceso es de solo lectura. Puedes exportar o descartar tu borrador local.",
        );
      const resource = buildCapturedResource(
        value,
        user,
        workspace.id,
        resources,
      );
      const result = await save(resource);
      if (!result)
        throw new Error(
          "No se pudo guardar la captura. El borrador se conserva.",
        );
      await draft.clear();
      setDirty(false);
      if (andOpen) {
        close();
        open(result);
      } else {
        setValue(fresh(value.kind, value.destinationId));
        setMessage(
          `«${result.title}» guardado en este dispositivo${online ? "." : "; se sincronizará al reconectar."}`,
        );
        titleRef.current?.focus();
      }
    });
  const exportDraft = () => {
    const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                type: "quick-capture-draft",
                schemaVersion: 1,
                workspaceId: workspace.id,
                value,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = "captura-borrador.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Modal
      title="Captura rápida"
      close={requestClose}
      className="quick-capture-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(
            (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
              "data-open",
            ) === "true",
          );
        }}
      >
        <p className="capture-scope">
          Espacio: {workspace.name}. Puedes cerrar y recuperar este borrador en
          este dispositivo.
        </p>
        {!canEdit && (
          <p className="notice" role="status">
            Tu acceso es de solo lectura. Puedes recuperar, exportar o descartar
            tu borrador local.
          </p>
        )}
        <fieldset disabled={!canEdit || busy || !draft.ready}>
          <Field label="Tipo de captura">
            <select
              value={value.kind}
              onChange={(event) => {
                const kind = event.target.value as CaptureDraft["kind"],
                  destinationId =
                    kind === "task" && destination?.kind !== "project"
                      ? ""
                      : value.destinationId;
                patch({
                  kind,
                  destinationId,
                  customFields:
                    kind === "task"
                      ? destination?.kind === "project"
                        ? {
                            ...fieldDefaults(
                              destination.data.fieldDefinitions || [],
                            ),
                            ...value.customFields,
                          }
                        : {}
                      : value.customFields,
                });
              }}
            >
              <option value="private_note">Nota personal</option>
              <option value="task">Tarea</option>
              <option value="document">Documento del espacio</option>
            </select>
          </Field>
          <Field label="Título de la captura">
            <input
              ref={titleRef}
              autoFocus
              required
              maxLength={500}
              value={value.title}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </Field>
          <Field label="Contenido de la captura">
            <textarea
              rows={5}
              maxLength={50000}
              value={value.text}
              onChange={(event) => patch({ text: event.target.value })}
            />
          </Field>
          <Field label="Enlace de origen">
            <input
              type="url"
              maxLength={1000}
              value={value.sourceUrl}
              placeholder="https://"
              onChange={(event) => patch({ sourceUrl: event.target.value })}
            />
          </Field>
          <p className="capture-privacy">
            {value.kind === "private_note"
              ? "Nota personal: solo tu cuenta podrá consultarla en la aplicación."
              : value.destinationId
                ? "La captura heredará el acceso de su ubicación."
                : "La captura estará disponible para quienes tengan acceso a este espacio."}{" "}
            El enlace se guarda sin consultar la página externa.
          </p>
          {value.kind !== "private_note" && (
            <>
              <Field label="Buscar ubicación de la captura">
                <input
                  type="search"
                  value={locationQuery}
                  onChange={(event) => setLocationQuery(event.target.value)}
                />
              </Field>
              <Field
                label={
                  value.kind === "task"
                    ? "Proyecto de la captura"
                    : "Ubicación de la captura"
                }
              >
                <select
                  value={value.destinationId}
                  onChange={(event) => {
                    const selected = resources.find(
                      (resource) => resource.id === event.target.value,
                    );
                    patch({
                      destinationId: event.target.value,
                      customFields:
                        value.kind === "task"
                          ? fieldDefaults(selected?.data.fieldDefinitions || [])
                          : {},
                    });
                  }}
                >
                  <option value="">Raíz del espacio</option>
                  {options.map((resource) => (
                    <option key={resource.id} value={resource.id}>
                      {resource.title.slice(0, 100)}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {value.kind === "task" && (
            <>
              <label className="checklist-item">
                <input
                  type="checkbox"
                  checked={value.assignToMe}
                  onChange={(event) =>
                    patch({ assignToMe: event.target.checked })
                  }
                />
                Asignarme la tarea
              </label>
              <Field label="Fecha límite de la captura">
                <input
                  type="date"
                  value={value.dueDate}
                  onChange={(event) => patch({ dueDate: event.target.value })}
                />
              </Field>
              <ConfiguredTaskFields
                definitions={destination?.data.fieldDefinitions || []}
                values={value.customFields}
                change={(customFields) => patch({ customFields })}
                editable={!busy}
                members={members}
                required
                sectionLabel="Campos de la tarea capturada"
              />
            </>
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {draft.issue && <p role="alert">{draft.issue}</p>}
        <p role="status">
          {message ||
            (dirty
              ? draft.saved
                ? "Borrador de captura guardado en este dispositivo."
                : "Guardando el borrador de captura…"
              : "")}
        </p>
        <div className="capture-actions">
          {canEdit && (
            <button
              className="primary"
              disabled={busy || !draft.ready || !value.title.trim()}
            >
              Guardar y capturar otra
            </button>
          )}
          {canEdit && (
            <button
              type="submit"
              data-open="true"
              disabled={busy || !draft.ready || !value.title.trim()}
            >
              Guardar y abrir
            </button>
          )}
          <button type="button" onClick={exportDraft}>
            Exportar borrador de captura
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await draft.clear();
                setDirty(false);
                setValue(fresh());
                setMessage("Borrador de captura descartado.");
              })
            }
          >
            Descartar borrador de captura
          </button>
        </div>
        {!online && (
          <p className="muted">
            Sin conexión: las capturas se guardarán en este dispositivo. Revisa
            su sincronización al reconectar.
          </p>
        )}
      </form>
    </Modal>
  );
}
