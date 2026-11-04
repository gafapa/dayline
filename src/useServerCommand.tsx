import { useLocalGuard } from "./useLocalGuard";
import { useEffect, useState } from "react";
import { api, ApiError, send } from "./api";
import { readUserDraft, writeUserDraft, removeUserDraft } from "./storage";
type Command = { path: string; body: Record<string, any> };
export function useServerCommand(
  userId: string,
  workspaceId: string,
  scope: string,
  onRecovered: (result: any, command: Command) => Promise<void>,
) {
  const key = `${workspaceId}:command:${scope}`;
  const [pending, setPending] = useState<Command | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [executing, setExecuting] = useState(false),
    [error, setError] = useState("");
  useLocalGuard(
    pending || executing || busy
      ? "Hay un comando pendiente de confirmar. Espera o reinténtalo antes de cerrar sesión."
      : "",
  );
  const valid = (value: any): value is Command =>
    !!value &&
    typeof value.path === "string" &&
    value.path.startsWith(`/workspaces/${workspaceId}/`) &&
    typeof value.body?.operationId === "string";
  useEffect(() => {
    let disposed = false;
    void readUserDraft(userId, key)
      .then((value) => {
        if (disposed) return;
        if (value && !valid(value)) {
          setError("El comando local no es válido. Se conserva para revisión.");
          return;
        }
        setPending(value || null);
        setReady(true);
      })
      .catch(() => {
        if (!disposed)
          setError(
            "No se pudo abrir el comando local. Se conserva para revisión.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [userId, key]);
  const locked = <T,>(work: () => Promise<T>) =>
    navigator.locks
      ? navigator.locks.request(`kelvin-command:${userId}:${key}`, work)
      : work();
  async function execute(command: Command) {
    setExecuting(true);
    try {
      const result = await api(command.path, send(command.body));
      await removeUserDraft(userId, key);
      setPending(null);
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        await removeUserDraft(userId, key);
        setPending(null);
      } else setPending(command);
      throw e;
    } finally {
      setExecuting(false);
    }
  }
  const run = async (path: string, body: Record<string, any>) => {
    if (!ready) throw new Error("Espera a que se revise el comando pendiente.");
    setError("");
    return locked(async () => {
      const prior = await readUserDraft(userId, key);
      if (prior) {
        if (valid(prior)) setPending(prior);
        throw new Error(
          "Hay un comando pendiente de confirmar. Reinténtalo desde el aviso para evitar duplicados.",
        );
      }
      const command = {
        path,
        body: { ...body, operationId: crypto.randomUUID() },
      };
      await writeUserDraft(userId, key, command);
      setPending(command);
      return execute(command);
    });
  };
  const recovery =
    (pending && !executing) || error ? (
      <div className="bulk-controls" role="status">
        <p>
          {error ||
            "La respuesta de un comando no está confirmada. Reintentar utiliza el mismo identificador, incluso después de recargar, para evitar copias duplicadas."}
        </p>
        {pending && (
          <button
            className="secondary"
            disabled={busy || !navigator.onLine}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await locked(async () => {
                  const command = await readUserDraft(userId, key);
                  if (!command) {
                    setPending(null);
                    return;
                  }
                  if (!valid(command))
                    throw new Error("Comando local no válido.");
                  const result = await execute(command);
                  await onRecovered(result, command);
                });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Reintentar comando pendiente
          </button>
        )}
      </div>
    ) : null;
  return { run, recovery, ready };
}
