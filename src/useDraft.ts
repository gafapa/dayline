import { useLocalGuard } from "./useLocalGuard";
import { useEffect, useRef, useState } from "react";
import { readUserDraft, writeUserDraft, removeUserDraft } from "./storage";
/** Keeps an unsaved long form in local storage until it is saved or discarded. */
export function useDraft(
  userId: string,
  key: string,
  snapshot: unknown,
  dirty: boolean,
  restore: (value: any) => void,
  enabled = true,
) {
  useLocalGuard(
    enabled && dirty
      ? "Hay un borrador abierto sin guardar. Guárdalo o descártalo antes de cerrar sesión."
      : "",
  );
  const [readyKey, setReadyKey] = useState<string | null>(null),
    [saved, setSaved] = useState(false),
    [issue, setIssue] = useState(""),
    restoreRef = useRef(restore);
  restoreRef.current = restore;
  const scope = userId + ":" + key,
    ready = !enabled || readyKey === scope;
  useEffect(() => {
    let disposed = false;
    setReadyKey(null);
    if (!enabled) {
      return;
    }
    void readUserDraft(userId, key)
      .then((value) => {
        if (disposed) return;
        if (value) restoreRef.current(value);
        setReadyKey(scope);
      })
      .catch(() => {
        if (!disposed)
          setIssue(
            "No se ha podido abrir el borrador local. Se conserva para revisión. Puedes descartarlo explícitamente para volver a los datos del servidor.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [userId, key, enabled]);
  const serialized = JSON.stringify(snapshot);
  useEffect(() => {
    if (!ready || !dirty || !enabled) return;
    let disposed = false;
    setSaved(false);
    void writeUserDraft(userId, key, JSON.parse(serialized), true)
      .then(() => {
        if (!disposed) setSaved(true);
      })
      .catch(() => {
        if (!disposed)
          setIssue(
            "No se ha podido guardar el borrador en este dispositivo. Mantén esta pantalla abierta y guarda los cambios en el servidor.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [userId, key, serialized, dirty, ready, enabled]);
  const clear = async () => {
    await removeUserDraft(userId, key);
    setIssue("");
    setSaved(false);
    setReadyKey(scope);
  };
  return { ready, saved, issue, clear };
}
