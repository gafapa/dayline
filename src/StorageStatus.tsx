import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LOCAL_DATABASE_EVENT, localDatabaseIssues } from "./local-database";

export function StorageStatus() {
  const [issues, setIssues] = useState(localDatabaseIssues);
  const [target, setTarget] = useState<Element>(document.body);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const update = () => {
      setDismissed(false);
      setIssues(localDatabaseIssues());
    };
    window.addEventListener(LOCAL_DATABASE_EVENT, update);
    update();
    return () => window.removeEventListener(LOCAL_DATABASE_EVENT, update);
  }, []);
  useEffect(() => {
    if (!issues.length) return;
    const update = () =>
      setTarget(
        [...document.querySelectorAll("dialog[open]")].at(-1) || document.body,
      );
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    update();
    return () => observer.disconnect();
  }, [Boolean(issues.length)]);
  if (!issues.length || dismissed) return null;
  const outdated = issues.includes("outdated");
  return createPortal(
    <aside
      className="local-storage-notice"
      role="alert"
      aria-label="Almacenamiento local"
    >
      <strong>
        {outdated
          ? "Esta pestaña necesita actualizarse"
          : "Esperando al almacenamiento local"}
      </strong>
      <p>
        {outdated
          ? "Otra pestaña ha actualizado el almacenamiento. Conserva o exporta los cambios que tengas abiertos antes de recargar. Las copias existentes no se han borrado."
          : "Guarda los cambios y cierra las otras pestañas de esta aplicación. La operación continuará automáticamente cuando liberen el almacenamiento; no borres los datos del navegador."}
      </p>
      {outdated && (
        <div className="local-storage-actions">
          <button className="secondary" onClick={() => setDismissed(true)}>
            Seguir revisando mis cambios
          </button>
          <button
            className="secondary"
            onClick={() => {
              if (
                confirm(
                  "Comprueba que has conservado tus cambios antes de actualizar esta pestaña. ¿Continuar?",
                )
              )
                location.reload();
            }}
          >
            Actualizar pestaña
          </button>
        </div>
      )}
    </aside>,
    target,
  );
}
