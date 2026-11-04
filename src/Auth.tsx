import { Field } from "./components/Primitives";
import { Suspense, lazy, useState, type FormEvent } from "react";
import { ArrowRight, ChevronRight, FileText, LoaderCircle, Target, Layers } from "lucide-react";
import { api, ApiError, send } from "./api";
const Setup = lazy(() => import("./Setup"));

export function Auth({
  boot,
  error,
  ready,
}: {
  boot: any;
  error: string;
  ready: () => void;
}) {
  const invitation = new URLSearchParams(location.search).get("invitation");
  const setup = boot?.setupRequired && !invitation;
  const [busy, setBusy] = useState(false),
    [localError, setLocalError] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false),
    [recovering, setRecovering] = useState(false),
    [useRecovery, setUseRecovery] = useState(false),
    [recovered, setRecovered] = useState(false),
    [resetToken, setResetToken] = useState(() =>
      new URLSearchParams(location.search).get("reset"),
    ),
    [resetDone, setResetDone] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setLocalError("");
    const { passwordConfirm, ...data } = Object.fromEntries(
      new FormData(event.currentTarget),
    );
    if (
      passwordConfirm !== undefined &&
      passwordConfirm !== (recovering ? data.newPassword : data.password)
    ) {
      setLocalError("Las contraseñas no coinciden.");
      setBusy(false);
      return;
    }
    try {
      await api(
        recovering
          ? "/account/recover"
          : invitation
            ? "/invitations/accept"
            : setup
              ? "/setup"
              : "/login",
        send({ ...data, ...(invitation ? { token: invitation } : {}) }),
      );
      if (recovering) {
        setRecovering(false);
        setRecovered(true);
        setMfaRequired(false);
        event.currentTarget?.reset();
      } else {
        history.replaceState({}, "", location.pathname);
        ready();
      }
    } catch (e) {
      setLocalError((e as Error).message);
      if (e instanceof ApiError && e.detail?.mfaRequired) setMfaRequired(true);
    } finally {
      setBusy(false);
    }
  };
  if (setup)
    return (
      <Suspense fallback={null}>
        <Setup boot={boot} ready={ready} />
      </Suspense>
    );
  if (resetToken)
    return (
      <PasswordReset
        token={resetToken}
        done={() => {
          history.replaceState({}, "", location.pathname);
          setResetToken(null);
          setResetDone(true);
        }}
      />
    );
  return (
    <div className="auth-page">
      <div className="auth-intro">
        <a className="brand" href="/">
          <img src="/mark.svg" alt="" />
          Dayline
        </a>
        <div>
          <span className="eyebrow">Menos dispersión. Más claridad.</span>
          <h1>
            Del primer apunte
            <br />
            al próximo sprint.
          </h1>
          <p>
            Documentos, proyectos y personas.
            <br />
            Todo lo que necesitas para avanzar juntos.
          </p>
          <div className="auth-path">
            <span>
              <FileText size={18} />
              Documenta
            </span>
            <ChevronRight size={16} />
            <span>
              <Layers size={18} />
              Organiza
            </span>
            <ChevronRight size={16} />
            <span>
              <Target size={18} />
              Avanza
            </span>
          </div>
        </div>
        <small>Tu trabajo conserva su contexto.</small>
      </div>
      <div className="auth-form-wrap">
        <form onSubmit={submit} className="auth-form">
          <h2>
            {invitation
              ? "Únete al equipo"
              : setup
                ? "Crea tu espacio"
                : "Vuelve a tu espacio"}
          </h2>
          <p>
            {invitation
              ? "Completa tu cuenta para aceptar la invitación."
              : setup
                ? "Empieza con un espacio propio y añade a tu equipo."
                : "Inicia sesión para continuar con tu trabajo."}
          </p>
          {(error || localError) && (
            <div className="notice error" role="alert">
              {localError || error}
            </div>
          )}
          {resetDone && !localError && (
            <p className="notice" role="status">
              Contraseña actualizada. Inicia sesión con la nueva contraseña.
            </p>
          )}
          {(setup || invitation) && (
            <Field label="Tu nombre">
              <input name="name" required autoComplete="name" maxLength={100} />
            </Field>
          )}
          <Field label="Correo electrónico">
            <input name="email" type="email" required autoComplete="username" />
          </Field>
          {recovered && (
            <p role="status">
              Contraseña actualizada. Inicia sesión; la verificación en dos
              pasos sigue activa si la habías configurado.
            </p>
          )}
          <Field label={recovering ? "Nueva contraseña" : "Contraseña"}>
            <input
              name={recovering ? "newPassword" : "password"}
              type="password"
              minLength={8}
              maxLength={200}
              required
              autoComplete={
                setup || invitation || recovering
                  ? "new-password"
                  : "current-password"
              }
            />
          </Field>
          {(invitation || recovering) && (
            <Field label="Repite la contraseña">
              <input
                name="passwordConfirm"
                type="password"
                minLength={8}
                maxLength={200}
                required
                autoComplete="new-password"
              />
            </Field>
          )}
          {((mfaRequired && !useRecovery) || false) && !recovering && (
            <Field label="Código de autenticación">
              <input
                name="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
              />
            </Field>
          )}
          {(recovering || (mfaRequired && useRecovery)) && (
            <Field label="Código de recuperación">
              <input name="recoveryCode" autoComplete="off" required />
            </Field>
          )}
          {mfaRequired && !recovering && (
            <button
              className="text-button"
              type="button"
              onClick={() => setUseRecovery(!useRecovery)}
            >
              {useRecovery
                ? "Usar el autenticador"
                : "Usar un código de recuperación"}
            </button>
          )}
          {(setup || invitation) && (
            <small>Utiliza al menos 8 caracteres.</small>
          )}
          {setup && (
            <Field label="Nombre del espacio">
              <input
                name="workspaceName"
                required
                defaultValue="Mi equipo"
                maxLength={100}
              />
            </Field>
          )}
          {setup && boot.setupTokenRequired && (
            <Field label="Código de configuración">
              <input
                name="setupToken"
                type="password"
                required
                autoComplete="off"
              />
            </Field>
          )}
          <button className="primary" disabled={busy || !boot}>
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            {recovering
              ? "Recuperar cuenta"
              : invitation
                ? "Aceptar invitación"
                : setup
                  ? "Crear espacio"
                  : "Entrar"}
            <ArrowRight size={16} />
          </button>
          {!setup && !invitation && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setRecovering(!recovering);
                setLocalError("");
                setRecovered(false);
              }}
            >
              {recovering
                ? "Volver al inicio de sesión"
                : "Recuperar con un código de seguridad"}
            </button>
          )}
          <small>El acceso al equipo se realiza mediante invitación.</small>
        </form>
      </div>
    </div>
  );
}

/** Sets a new password from a single-use link created by platform administration. */
export function PasswordReset({ token, done }: { token: string; done: () => void }) {
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  return (
    <div className="auth-page auth-reset">
      <div className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget),
              newPassword = String(data.get("newPassword") || ""),
              repeat = String(data.get("repeat") || "");
            setIssue("");
            if (newPassword !== repeat) {
              setIssue("Las dos contraseñas no coinciden.");
              return;
            }
            setBusy(true);
            try {
              await api("/account/reset", send({ token, newPassword }));
              done();
            } catch (e) {
              setIssue((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <a className="brand" href="/">
            <img src="/mark.svg" alt="" />
            Dayline
          </a>
          <h2>Nueva contraseña</h2>
          <p>
            Elige una contraseña de al menos 8 caracteres. Se cerrarán todas
            tus sesiones abiertas.
          </p>
          {issue && (
            <div className="notice error" role="alert">
              {issue}
            </div>
          )}
          <Field label="Nueva contraseña">
            <input
              name="newPassword"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label="Repite la contraseña">
            <input
              name="repeat"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
            />
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            Guardar contraseña
          </button>
        </form>
      </div>
    </div>
  );
}
