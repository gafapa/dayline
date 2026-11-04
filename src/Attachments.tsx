import { useEffect, useState } from "react";
import { Paperclip, Download, Trash2 } from "lucide-react";
import { api, send } from "./api";
import { flushOutbox } from "./storage";
export async function uploadAttachment(
  file: File,
  workspaceId: string,
  resourceId: string,
  userId: string,
) {
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Cada archivo puede ocupar hasta 5 MiB.");
  await flushOutbox(userId, workspaceId, () => {});
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
  return (
    await api(
      `/workspaces/${workspaceId}/resources/${resourceId}/attachments`,
      send({ name: file.name, mime: file.type, base64 }),
    )
  ).attachment;
}
export function Attachments({
  workspaceId,
  resourceId,
  userId,
  editable,
  error,
}: {
  workspaceId: string;
  resourceId: string;
  userId: string;
  editable: boolean;
  error: (value: string) => void;
}) {
  const [files, setFiles] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = () =>
    api(`/workspaces/${workspaceId}/resources/${resourceId}/attachments`)
      .then((result) => {
        setFiles(result.attachments);
        setMessage("");
      })
      .catch(() =>
        setMessage(
          "Los adjuntos necesitan conexión y que el elemento esté sincronizado.",
        ),
      );
  useEffect(() => {
    void load();
  }, [workspaceId, resourceId]);
  return (
    <section className="attachments">
      <div className="section-heading">
        <h3>
          <Paperclip size={16} />
          Adjuntos
        </h3>
        {editable && (
          <label className="upload-button">
            {busy ? "Subiendo…" : "Añadir archivo"}
            <input
              className="sr-only"
              type="file"
              disabled={busy}
              onChange={async (event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                setBusy(true);
                try {
                  await uploadAttachment(file, workspaceId, resourceId, userId);
                  await load();
                } catch (e) {
                  error((e as Error).message);
                } finally {
                  setBusy(false);
                  input.value = "";
                }
              }}
            />
          </label>
        )}
      </div>
      {message && <p className="muted">{message}</p>}
      {files.map((file) => (
        <div className="attachment-row" key={file.id}>
          <span>
            <strong>{file.name}</strong>
            <small>{(file.size / 1024).toFixed(1)} KiB</small>
          </span>
          <a
            href={`/api/workspaces/${workspaceId}/attachments/${file.id}?download=1`}
            download={file.name}
            aria-label={`Descargar ${file.name}`}
          >
            <Download size={16} />
          </a>
          {editable && (
            <button
              className="icon-button danger"
              aria-label={`Eliminar adjunto ${file.name}`}
              onClick={async () => {
                if (!confirm(`¿Eliminar el adjunto «${file.name}»?`)) return;
                try {
                  await api(
                    `/workspaces/${workspaceId}/attachments/${file.id}`,
                    { method: "DELETE" },
                  );
                  await load();
                } catch (e) {
                  error((e as Error).message);
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ))}
      {!files.length && !message && (
        <p className="muted">Sin adjuntos. Hasta 5 MiB por archivo.</p>
      )}
    </section>
  );
}
