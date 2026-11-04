import { useEffect, useRef, useState } from "react";
import { SESSION_FREEZE_EVENT, sessionIsFrozen } from "./session-coordination";

export function SessionStatus() {
  const [frozen, setFrozen] = useState(sessionIsFrozen);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const update = () => setFrozen(sessionIsFrozen());
    window.addEventListener(SESSION_FREEZE_EVENT, update);
    return () => window.removeEventListener(SESSION_FREEZE_EVENT, update);
  }, []);
  useEffect(() => {
    if (frozen) ref.current?.showModal();
    else ref.current?.close();
  }, [frozen]);
  return (
    <dialog
      ref={ref}
      className="modal session-status"
      aria-labelledby="session-status-title"
      onCancel={(event) => event.preventDefault()}
    >
      <h2 id="session-status-title">Comprobando el cierre de sesión</h2>
      <p role="status">
        Revisando los cambios pendientes de todas las pestañas. Espera un
        momento.
      </p>
    </dialog>
  );
}
