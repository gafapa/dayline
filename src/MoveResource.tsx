import { useEffect, useState } from "react";
import type { Resource, User, Workspace } from "../shared/model";
import {
  acceptsChild,
  isStructure,
  structureBranch,
  structureParent,
  structurePath,
  type MovePreview,
} from "../shared/hierarchy";
import { Field, Modal } from "./components/Primitives";
import { api, send } from "./api";
import { useServerCommand } from "./useServerCommand";

const pathName = (r: Resource, all: Resource[]) => {
  try {
    return structurePath(r.id, all)
      .map((p) => p.title)
      .join(" / ");
  } catch {
    return r.title;
  }
};

/**
 * Moves a project, folder or document after the server has reviewed the move: the preview
 * says what changes location or project, and the confirmed move is applied at most once.
 * With `initialDestination` (a drop), the review starts right away.
 */
export default function MoveResource({
  resource,
  initialDestination,
  resources,
  workspace,
  user,
  refresh,
  close,
  done,
}: {
  resource: Resource;
  initialDestination?: string | null;
  resources: Resource[];
  workspace: Workspace;
  user: User;
  refresh: () => Promise<void>;
  close: () => void;
  done: (message: string) => void;
}) {
  const finish = async () => {
    await refresh();
    close();
    done(`«${resource.title}» se ha movido.`);
  };
  const command = useServerCommand(user.id, workspace.id, "hierarchy", finish);
  const [destination, setDestination] = useState(
      initialDestination !== undefined ? initialDestination || "" : structureParent(resource) || "",
    ),
    [preview, setPreview] = useState<MovePreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const excluded = new Set(structureBranch(resource.id, resources).map((r) => r.id));
  const review = (destinationId: string | null) =>
    api<MovePreview>(
      `/workspaces/${workspace.id}/hierarchy/preview`,
      send({ id: resource.id, destinationId }),
    );
  useEffect(() => {
    if (initialDestination === undefined || !navigator.onLine) return;
    let current = true;
    setBusy(true);
    review(initialDestination || null)
      .then((value) => current && setPreview(value))
      .catch((e) => current && setError((e as Error).message))
      .finally(() => current && setBusy(false));
    return () => {
      current = false;
    };
  }, []);
  return (
    <Modal title={`Mover ${resource.title}`} close={close}>
      <div className="modal-body">
        {command.recovery}
        <p>
          El movimiento conserva los documentos y actualiza juntos su ubicación y proyecto. Se
          aplicarán los permisos de la nueva ubicación.
        </p>
        {error && <p role="alert">{error}</p>}
        <Field label="Nueva ubicación">
          <select
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Raíz del espacio</option>
            {resources
              .filter(
                (r) =>
                  isStructure(r) &&
                  !r.deleted_at &&
                  !r.data.archived &&
                  !excluded.has(r.id) &&
                  acceptsChild(r.kind, resource.kind),
              )
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {pathName(r, resources)}
                </option>
              ))}
          </select>
        </Field>
        {preview && (
          <div className="structure-preview" role="status">
            <p>
              {preview.title} → {preview.destinationTitle}
            </p>
            <p>
              {preview.affectedCount} elementos en la estructura; {preview.changes.length} cambios de
              ubicación o proyecto.
            </p>
            <p>
              El contenido puede ser visible para otras personas en el destino. Las revisiones del
              documento siguen los permisos del destino.
            </p>
          </div>
        )}
        {!navigator.onLine && <p>Conéctate para revisar y confirmar este movimiento.</p>}
        <div className="form-actions">
          <button onClick={close}>Cancelar</button>
          <button
            className="primary"
            disabled={busy || !navigator.onLine || !command.ready}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                if (preview) {
                  await command.run(`/workspaces/${workspace.id}/hierarchy/move`, {
                    id: resource.id,
                    destinationId: preview.destinationId,
                    fingerprint: preview.fingerprint,
                  });
                  await finish();
                } else {
                  await refresh();
                  setPreview(await review(destination || null));
                }
              } catch (e) {
                setPreview(null);
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Comprobando…" : preview ? "Confirmar movimiento" : "Revisar movimiento"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
