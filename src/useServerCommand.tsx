import { useLocalGuard } from "./useLocalGuard";
import { useState } from "react";
import { api, ApiError, send } from "./api";
type Command = { path: string; body: Record<string, any> };

/**
 * Runs a multi-step server command with an idempotency key. If the response is lost, the
 * retry reuses the same `operationId`, so the server applies the command at most once.
 */
export function useServerCommand(
  _userId: string,
  _workspaceId: string,
  _scope: string,
  onRecovered: (result: any, command: Command) => Promise<void>,
) {
  const [pending, setPending] = useState<Command | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useLocalGuard(
    pending || busy
      ? "Hay un comando pendiente de confirmar. Espera o reinténtalo antes de cerrar sesión."
      : "",
  );
  async function execute(command: Command) {
    setBusy(true);
    try {
      const result = await api(command.path, send(command.body));
      setPending(null);
      return result;
    } catch (e) {
      // A definite rejection (4xx) is final; anything else may have been applied.
      setPending(e instanceof ApiError && e.status < 500 ? null : command);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const run = async (path: string, body: Record<string, any>) => {
    if (pending)
      throw new Error(
        "Hay un comando pendiente de confirmar. Reinténtalo desde el aviso para evitar duplicados.",
      );
    setError("");
    return execute({ path, body: { ...body, operationId: crypto.randomUUID() } });
  };
  const recovery =
    pending && !busy ? (
      <div className="bulk-controls" role="status">
        <p>
          {error ||
            "La respuesta de un comando no está confirmada. Reintentar utiliza el mismo identificador para evitar copias duplicadas."}
        </p>
        <button
          className="secondary"
          disabled={!navigator.onLine}
          onClick={async () => {
            setError("");
            try {
              const command = pending;
              const result = await execute(command);
              await onRecovered(result, command);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Reintentar comando pendiente
        </button>
      </div>
    ) : null;
  return { run, recovery, ready: true };
}
