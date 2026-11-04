import { useEffect, useState } from "react";
import { Field } from "./components/Primitives";
import { api, send } from "./api";
import type { User, Workspace } from "../shared/model";

type Row = {
  id: string;
  name: string;
  role: Workspace["role"];
  created_at?: string;
  member_count?: number;
  admin_count?: number;
};
const roleLabels: Record<string, string> = {
  admin: "Administración",
  member: "Miembro",
  viewer: "Solo lectura",
  guest: "Invitado",
};

/** Lists the person's workspaces and lets them create, rename, hide, open or leave them. */
export default function WorkspaceManager({
  workspaces,
  currentId,
  hidden,
  setHidden,
  open,
  reload,
  notify,
  error,
}: {
  workspaces: Workspace[];
  currentId: string;
  user: User;
  hidden: string[];
  setHidden: (ids: string[]) => void;
  open: (id: string) => void;
  reload: () => Promise<unknown>;
  notify: (message: string) => void;
  error: (message: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>(workspaces),
    [detailed, setDetailed] = useState(false),
    [names, setNames] = useState<Record<string, string>>({}),
    [leaving, setLeaving] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const response = await api<{ workspaces: Row[] }>("/workspaces");
      setRows(response.workspaces);
      setDetailed(true);
    } catch {
      setRows(workspaces);
      setDetailed(false);
    }
  };
  useEffect(() => {
    void load();
  }, [workspaces.map((w) => `${w.id}:${w.name}:${w.role}`).join("|")]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const online = navigator.onLine;
  return (
    <div className="workspace-manager">
      <section className="settings-section">
        <div>
          <h2>Nuevo espacio</h2>
          <p>Organiza otro equipo con proyectos y permisos independientes.</p>
        </div>
        <form
          className="workspace-create"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              name = String(new FormData(form).get("name") || "").trim();
            if (!name) return;
            void run(async () => {
              const created = await api<{ id: string }>(
                "/workspaces",
                send({ name }),
              );
              form.reset();
              await reload();
              notify("Espacio creado.");
              open(created.id);
            });
          }}
        >
          <Field label="Nombre del espacio">
            <input name="name" required maxLength={100} disabled={!online} />
          </Field>
          <button className="primary" disabled={busy || !online}>
            Crear espacio
          </button>
        </form>
      </section>

      <section aria-labelledby="workspace-list-title">
        <h2 id="workspace-list-title" className="workspace-list-title">
          Tus espacios · {rows.length}
        </h2>
        {!online && (
          <p className="muted">
            Sin conexión: puedes abrir y ocultar espacios. Crear, renombrar y
            salir necesitan conexión.
          </p>
        )}
        <ul className="workspace-list">
          {rows.map((row) => {
            const current = row.id === currentId,
              isHidden = hidden.includes(row.id),
              admin = row.role === "admin",
              draft = names[row.id] ?? row.name,
              lastAdmin = admin && detailed && (row.admin_count ?? 1) <= 1,
              only = rows.length <= 1;
            return (
              <li key={row.id} className="workspace-row">
                <div className="workspace-row-main">
                  {admin ? (
                    <form
                      className="workspace-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = draft.trim();
                        if (!name || name === row.name) return;
                        void run(async () => {
                          await api(
                            `/workspaces/${row.id}`,
                            send({ name }, "PATCH"),
                          );
                          setNames(({ [row.id]: _, ...rest }) => rest);
                          await reload();
                          notify("Espacio renombrado.");
                        });
                      }}
                    >
                      <Field label={`Nombre de ${row.name}`}>
                        <input
                          value={draft}
                          maxLength={100}
                          required
                          disabled={!online}
                          onChange={(e) =>
                            setNames((n) => ({ ...n, [row.id]: e.target.value }))
                          }
                        />
                      </Field>
                      {draft.trim() !== row.name && (
                        <button disabled={busy || !online || !draft.trim()}>
                          Guardar nombre
                        </button>
                      )}
                    </form>
                  ) : (
                    <strong>{row.name}</strong>
                  )}
                  <span className="muted">
                    {roleLabels[row.role] || row.role}
                    {detailed && row.member_count !== undefined
                      ? ` · ${row.member_count} ${row.member_count === 1 ? "persona" : "personas"}`
                      : ""}
                    {row.created_at
                      ? ` · desde ${new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(new Date(row.created_at))}`
                      : ""}
                    {current ? " · Abierto ahora" : ""}
                    {lastAdmin && !only ? " · Única administración" : ""}
                    {isHidden ? " · Oculto en el selector" : ""}
                  </span>
                </div>
                <div className="workspace-row-actions">
                  {!current && (
                    <button onClick={() => open(row.id)}>Abrir</button>
                  )}
                  <button
                    disabled={current && !isHidden}
                    title={
                      current && !isHidden
                        ? "El espacio abierto siempre aparece en el selector."
                        : undefined
                    }
                    onClick={() =>
                      setHidden(
                        isHidden
                          ? hidden.filter((id) => id !== row.id)
                          : [...hidden, row.id],
                      )
                    }
                  >
                    {isHidden ? "Mostrar en el selector" : "Ocultar del selector"}
                  </button>
                  {leaving === row.id ? (
                    <>
                      <button
                        className="danger"
                        disabled={busy || !online}
                        onClick={() =>
                          void run(async () => {
                            await api(`/workspaces/${row.id}/leave`, send({}));
                            setLeaving("");
                            if (current) {
                              const next = rows.find((w) => w.id !== row.id);
                              if (next) open(next.id);
                            }
                            await reload();
                            notify(`Has salido de ${row.name}.`);
                          })
                        }
                      >
                        Confirmar salida
                      </button>
                      <button onClick={() => setLeaving("")}>Cancelar</button>
                    </>
                  ) : (
                    <button
                      disabled={busy || !online || lastAdmin || only}
                      title={
                        only
                          ? "Es tu único espacio."
                          : lastAdmin
                            ? "Nombra a otra persona administradora antes de salir."
                            : undefined
                      }
                      onClick={() => setLeaving(row.id)}
                    >
                      Salir del espacio
                    </button>
                  )}
                </div>
                {leaving === row.id && (
                  <p className="workspace-leave-note" role="alert">
                    Perderás el acceso a sus proyectos, documentos y notas
                    personales de este espacio. Una persona administradora
                    tendrá que invitarte de nuevo.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
