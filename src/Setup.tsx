import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Database,
  KeyRound,
  Globe,
  LoaderCircle,
  Rocket,
  UserRound,
  Users,
} from "lucide-react";
import { Field } from "./components/Primitives";
import { api, send } from "./api";

type Install = {
  version: string;
  production: boolean;
  database: "postgresql" | "local";
  encryption: boolean;
  origin: string;
};
const steps = ["Servidor", "Tu cuenta", "Tu espacio", "Listo"];

/** First-run installation wizard: server checks, first administrator and first workspace. */
export default function Setup({
  boot,
  ready,
}: {
  boot: { setupTokenRequired?: boolean; install?: Install };
  ready: () => void;
}) {
  const install = boot.install;
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [account, setAccount] = useState({ name: "", email: "", password: "" }),
    [repeat, setRepeat] = useState(""),
    [workspaceName, setWorkspaceName] = useState("Mi equipo"),
    [setupToken, setSetupToken] = useState("");
  const originMatches = !install || install.origin === location.origin;
  const checks = install
    ? [
        {
          icon: Database,
          ok: true,
          label: "Base de datos",
          text:
            install.database === "postgresql"
              ? "PostgreSQL conectado."
              : "Base de datos local integrada (ideal para probar o para un solo equipo pequeño).",
        },
        {
          icon: KeyRound,
          ok: install.encryption,
          label: "Clave de cifrado",
          text: install.encryption
            ? "Configurada. Los secretos de integraciones y la verificación en dos pasos se guardan cifrados."
            : "Sin ENCRYPTION_KEY: la app funciona, pero no podrás activar la verificación en dos pasos ni guardar claves de IA.",
        },
        {
          icon: Globe,
          ok: originMatches,
          label: "Dirección pública",
          text: originMatches
            ? `Los enlaces de invitación usarán ${install.origin}.`
            : `APP_ORIGIN es ${install.origin}, pero estás entrando por ${location.origin}. Los enlaces de invitación apuntarán a APP_ORIGIN.`,
        },
      ]
    : [];
  const next = (event: FormEvent) => {
    event.preventDefault();
    setIssue("");
    if (step === 1 && account.password !== repeat) {
      setIssue("Las contraseñas no coinciden.");
      return;
    }
    setStep(step + 1);
  };
  const finish = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setIssue("");
    try {
      await api(
        "/setup",
        send({
          ...account,
          workspaceName,
          ...(boot.setupTokenRequired ? { setupToken } : {}),
        }),
      );
      setStep(3);
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-page">
      <div className="setup-card">
        <div className="setup-brand">
          <img src="/mark.svg" alt="" />
          <span>
            <strong>Dayline</strong>
            <small>Instalación{install ? ` · versión ${install.version}` : ""}</small>
          </span>
        </div>
        <ol className="setup-steps" aria-label="Pasos de la instalación">
          {steps.map((label, index) => (
            <li
              key={label}
              className={index === step ? "current" : index < step ? "done" : ""}
              aria-current={index === step ? "step" : undefined}
            >
              <span>{index < step ? <CircleCheck size={14} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {issue && (
          <p className="notice error" role="alert">
            {issue}
          </p>
        )}

        {step === 0 && (
          <form onSubmit={next} className="setup-body">
            <h1>Te damos la bienvenida</h1>
            <p className="muted">
              En tres pasos tendrás Dayline listo: revisamos el servidor, creas
              la cuenta de administración y tu primer espacio de trabajo.
            </p>
            <ul className="setup-checks">
              {checks.map(({ icon: Icon, ok, label, text }) => (
                <li key={label} className={ok ? "ok" : "warn"}>
                  <span className="setup-check-icon">
                    <Icon size={18} />
                  </span>
                  <span>
                    <strong>
                      {label} {ok ? <CircleCheck size={15} aria-label="correcto" /> : <CircleAlert size={15} aria-label="aviso" />}
                    </strong>
                    <small>{text}</small>
                  </span>
                </li>
              ))}
            </ul>
            <div className="setup-actions">
              <button className="primary">
                Empezar
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        )}

        {step === 1 && (
          <form onSubmit={next} className="setup-body">
            <h1>
              <UserRound size={22} /> Tu cuenta
            </h1>
            <p className="muted">
              Será la cuenta de administración de la plataforma: podrá gestionar
              cuentas, espacios y personas.
            </p>
            <Field label="Tu nombre">
              <input
                required
                maxLength={100}
                autoComplete="name"
                value={account.name}
                onChange={(e) => setAccount({ ...account, name: e.target.value })}
              />
            </Field>
            <Field label="Correo electrónico">
              <input
                type="email"
                required
                autoComplete="username"
                value={account.email}
                onChange={(e) => setAccount({ ...account, email: e.target.value })}
              />
            </Field>
            <Field label="Contraseña">
              <input
                type="password"
                required
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                value={account.password}
                onChange={(e) => setAccount({ ...account, password: e.target.value })}
              />
            </Field>
            <Field label="Repite la contraseña">
              <input
                type="password"
                required
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </Field>
            <small className="muted">Utiliza al menos 8 caracteres.</small>
            <div className="setup-actions">
              <button type="button" onClick={() => setStep(0)}>
                <ArrowLeft size={16} />
                Atrás
              </button>
              <button className="primary">
                Continuar
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={finish} className="setup-body">
            <h1>
              <Users size={22} /> Tu espacio
            </h1>
            <p className="muted">
              Un espacio agrupa proyectos, documentos y personas. Podrás crear
              más y renombrarlos después.
            </p>
            <Field label="Nombre del espacio">
              <input
                required
                maxLength={100}
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
              />
            </Field>
            {boot.setupTokenRequired && (
              <Field label="Código de configuración">
                <input
                  type="password"
                  required
                  autoComplete="off"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                />
              </Field>
            )}
            {boot.setupTokenRequired && (
              <small className="muted">
                Es el valor de SETUP_TOKEN en la configuración del servidor.
                Impide que otra persona instale la app antes que tú.
              </small>
            )}
            <div className="setup-summary">
              <span>
                <small>Administración</small>
                <strong>{account.name}</strong>
                <small>{account.email}</small>
              </span>
              <span>
                <small>Espacio</small>
                <strong>{workspaceName || "—"}</strong>
              </span>
            </div>
            <div className="setup-actions">
              <button type="button" disabled={busy} onClick={() => setStep(1)}>
                <ArrowLeft size={16} />
                Atrás
              </button>
              <button className="primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : null}
                Crear espacio
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div className="setup-body">
            <h1>
              <Rocket size={22} /> Todo listo
            </h1>
            <p className="muted">
              Dayline está instalado y has iniciado sesión. Algunas ideas para
              empezar:
            </p>
            <ul className="setup-next">
              <li>
                <strong>Invita a tu equipo</strong>
                <small>Configuración → Equipo → Invitar persona.</small>
              </li>
              <li>
                <strong>Crea tu primer proyecto</strong>
                <small>Proyectos → Nuevo proyecto, con su flujo de estados.</small>
              </li>
              <li>
                <strong>Apunta cualquier cosa</strong>
                <small>Alt Q abre la captura rápida desde cualquier pantalla.</small>
              </li>
            </ul>
            <div className="setup-actions">
              <button className="primary" onClick={ready}>
                Ir a Hoy
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
