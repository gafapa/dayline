import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Field } from "./components/Primitives";
import { api, send } from "./api";
import type { User } from "../shared/model";

type Account = {
  id: string;
  email: string;
  name: string;
  created_at: string;
  last_login_at: string | null;
  suspended_at: string | null;
  platform_admin: boolean;
  mfa_enabled: boolean;
  session_count: number;
  workspaces: { id: string; name: string; role: string }[];
};
type Entry = {
  id: number;
  action: string;
  created_at: string;
  actor_email: string;
  target_email: string | null;
  details: Record<string, any>;
};
const roles: Record<string, string> = {
  admin: "administración",
  member: "miembro",
  viewer: "lectura",
  guest: "invitado",
};
const actions: Record<string, string> = {
  suspend: "suspendió",
  reactivate: "reactivó",
  revoke_sessions: "cerró las sesiones de",
  reset_mfa: "restableció el autenticador de",
  create_password_reset: "creó un enlace de contraseña para",
  complete_password_reset: "cambió su contraseña con un enlace",
  set_platform_admin: "cambió la administración de la plataforma de",
};
const when = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("es", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "Nunca";

/** Platform-wide account administration for platform administrators. */
export default function PlatformAdmin({
  user,
  notify,
}: {
  user: User;
  notify: (message: string) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]),
    [entries, setEntries] = useState<Entry[]>([]),
    [query, setQuery] = useState(""),
    [open, setOpen] = useState(""),
    [confirm, setConfirm] = useState(""),
    [link, setLink] = useState<{ id: string; url: string } | null>(null),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [loaded, setLoaded] = useState(false);
  const load = async (q = query) => {
    try {
      const [list, log] = await Promise.all([
        api<{ users: Account[] }>(
          `/platform/users${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
        ),
        api<{ entries: Entry[] }>("/platform/audit?limit=50"),
      ]);
      setAccounts(list.users);
      setEntries(log.entries);
      setIssue("");
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void load("");
  }, []);
  const act = async (
    account: Account,
    path: string,
    message: string,
    body: unknown = {},
  ) => {
    setBusy(true);
    setIssue("");
    try {
      const result = await api<any>(
        `/platform/users/${account.id}/${path}`,
        send(body),
      );
      if (result.url) setLink({ id: account.id, url: result.url });
      setConfirm("");
      notify(message);
      await load();
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!navigator.onLine)
    return (
      <p className="notice">
        La administración de la plataforma necesita conexión.
      </p>
    );
  return (
    <div className="platform-admin">
      <p className="muted">
        Cuentas de todo el servidor. Las acciones se aplican al momento y
        quedan registradas en el historial de abajo.
      </p>
      {issue && (
        <p className="notice error" role="alert">
          {issue}
        </p>
      )}
      <form
        className="platform-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <Field label="Buscar cuentas">
          <input
            value={query}
            placeholder="Nombre o correo"
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <button>Buscar</button>
      </form>

      <section aria-labelledby="platform-accounts-title">
        <h2 id="platform-accounts-title" className="platform-title">
          Cuentas · {loaded ? accounts.length : "…"}
        </h2>
        <ul className="platform-list">
          {accounts.map((account) => {
            const self = account.id === user.id,
              expanded = open === account.id;
            return (
              <li key={account.id} className="platform-row">
                <div className="platform-row-head">
                  <span className="avatar small">
                    {account.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="platform-identity">
                    <strong>
                      {account.name}
                      {self ? " (tú)" : ""}
                    </strong>
                    <span className="muted">{account.email}</span>
                  </div>
                  <div className="platform-badges">
                    {account.suspended_at && (
                      <span className="platform-badge danger">Suspendida</span>
                    )}
                    {account.platform_admin && (
                      <span className="platform-badge">Administración</span>
                    )}
                    {account.mfa_enabled && (
                      <span className="platform-badge">Autenticador</span>
                    )}
                  </div>
                  <button
                    aria-expanded={expanded}
                    onClick={() => {
                      setOpen(expanded ? "" : account.id);
                      setConfirm("");
                    }}
                  >
                    {expanded ? "Cerrar" : "Gestionar"}
                  </button>
                </div>
                <p className="muted platform-meta">
                  Último acceso: {when(account.last_login_at)} ·{" "}
                  {account.session_count}{" "}
                  {account.session_count === 1 ? "sesión abierta" : "sesiones abiertas"} ·{" "}
                  {account.workspaces.length
                    ? account.workspaces
                        .map((w) => `${w.name} (${roles[w.role] || w.role})`)
                        .join(", ")
                    : "Sin espacios"}
                </p>
                {expanded && (
                  <div className="platform-actions">
                    <button
                      disabled={busy || !account.session_count}
                      onClick={() =>
                        void act(account, "sessions/revoke", `Sesiones de ${account.email} cerradas.`)
                      }
                    >
                      Cerrar sesiones
                    </button>
                    <button
                      disabled={busy || !!account.suspended_at}
                      onClick={() =>
                        void act(account, "password-reset", "Enlace creado. Envíaselo a la persona.")
                      }
                    >
                      Crear enlace de nueva contraseña
                    </button>
                    {account.mfa_enabled &&
                      (confirm === `mfa:${account.id}` ? (
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void act(account, "mfa/reset", `Autenticador de ${account.email} restablecido.`)
                          }
                        >
                          Confirmar: quitar autenticador
                        </button>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() => setConfirm(`mfa:${account.id}`)}
                        >
                          Restablecer autenticador
                        </button>
                      ))}
                    {account.suspended_at ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(account, "reactivate", `${account.email} reactivada.`)
                        }
                      >
                        Reactivar cuenta
                      </button>
                    ) : confirm === `suspend:${account.id}` ? (
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          void act(account, "suspend", `${account.email} suspendida.`)
                        }
                      >
                        Confirmar suspensión
                      </button>
                    ) : (
                      <button
                        disabled={busy || self}
                        title={self ? "No puedes suspender tu propia cuenta." : undefined}
                        onClick={() => setConfirm(`suspend:${account.id}`)}
                      >
                        Suspender cuenta
                      </button>
                    )}
                    <button
                      disabled={busy || (self && account.platform_admin)}
                      title={
                        self && account.platform_admin
                          ? "Otra persona administradora debe retirar tu acceso."
                          : undefined
                      }
                      onClick={() =>
                        void act(
                          account,
                          "platform-admin",
                          account.platform_admin
                            ? `${account.email} ya no administra la plataforma.`
                            : `${account.email} administra la plataforma.`,
                          { platformAdmin: !account.platform_admin },
                        )
                      }
                    >
                      {account.platform_admin
                        ? "Quitar administración de la plataforma"
                        : "Hacer administración de la plataforma"}
                    </button>
                    {confirm.startsWith("suspend:") && confirm.endsWith(account.id) && (
                      <p className="platform-note" role="alert">
                        Se cerrarán sus sesiones y sus automatizaciones dejarán
                        de ejecutarse. Sus datos se conservan.
                      </p>
                    )}
                    {confirm === `mfa:${account.id}` && (
                      <p className="platform-note" role="alert">
                        Podrá entrar solo con su contraseña y deberá configurar
                        de nuevo el autenticador. Se cerrarán sus sesiones.
                      </p>
                    )}
                    {link?.id === account.id && (
                      <div className="platform-link" role="status">
                        <p>
                          Enlace de un solo uso, válido 24 horas. Solo se
                          muestra ahora:
                        </p>
                        <div>
                          <input
                            readOnly
                            aria-label="Enlace de nueva contraseña"
                            value={link.url}
                            onFocus={(e) => e.currentTarget.select()}
                          />
                          <button
                            aria-label="Copiar enlace"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(link.url);
                                notify("Enlace copiado.");
                              } catch {
                                notify("Selecciona el enlace y cópialo.");
                              }
                            }}
                          >
                            <Copy size={16} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="platform-audit-title">
        <h2 id="platform-audit-title" className="platform-title">
          Historial de administración
        </h2>
        {entries.length ? (
          <ul className="platform-audit">
            {entries.map((entry) => (
              <li key={entry.id}>
                <span className="muted">{when(entry.created_at)}</span>
                <span>
                  {entry.actor_email} {actions[entry.action] || entry.action}{" "}
                  {entry.action === "complete_password_reset"
                    ? ""
                    : entry.target_email}
                  {entry.action === "set_platform_admin" &&
                  entry.details?.platformAdmin !== undefined
                    ? entry.details.platformAdmin
                      ? " (concedida)"
                      : " (retirada)"
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Todavía no hay acciones registradas.</p>
        )}
      </section>
    </div>
  );
}
