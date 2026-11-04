import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck, KeyRound, Download } from "lucide-react";
import { api, send } from "./api";
import { Field } from "./components/Primitives";

export function SecuritySettings({
  notify,
  error,
}: {
  notify: (message: string) => void;
  error: (message: string) => void;
}) {
  const [status, setStatus] = useState<any>(null),
    [setup, setSetup] = useState<any>(null),
    [codes, setCodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const load = () =>
    api("/account/security")
      .then(setStatus)
      .catch((e) => error(e.message));
  useEffect(() => {
    void load();
  }, []);
  const perform = async (
    event: FormEvent<HTMLFormElement>,
    path: string,
    done?: (data: any) => void,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true);
    try {
      const result = await api(path, send(values));
      done?.(result);
      form.reset();
      await load();
      notify("Configuración de seguridad actualizada.");
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const proof = (
    <>
      <Field label="Contraseña actual">
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
        />
      </Field>
      {status?.mfaEnabled && (
        <>
          <Field label="Código de autenticación">
            <input
              name="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          </Field>
          <Field label="O código de recuperación">
            <input name="recoveryCode" autoComplete="off" />
          </Field>
        </>
      )}
    </>
  );
  if (!status)
    return <p role="status">Consultando la seguridad de tu cuenta…</p>;
  return (
    <>
      <section className="settings-section">
        <div>
          <h2>
            <KeyRound size={17} /> Cambiar contraseña
          </h2>
          <p>El cambio cerrará las demás sesiones de tu cuenta.</p>
        </div>
        <form onSubmit={(e) => void perform(e, "/account/password")}>
          {proof}
          <Field label="Nueva contraseña">
            <input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              minLength={8}
              maxLength={200}
              required
            />
          </Field>
          <button disabled={busy}>Actualizar contraseña</button>
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>
            <ShieldCheck size={17} /> Verificación en dos pasos
          </h2>
          <p>
            {status.mfaEnabled
              ? "Activada. La contraseña se combina con un código de tu aplicación de autenticación."
              : "Añade una segunda comprobación para acceder a tu cuenta."}
          </p>
        </div>
        <div className="settings-panel">
          {!status.mfaEnabled && !setup && (
            <form
              onSubmit={(e) => void perform(e, "/account/mfa/setup", setSetup)}
            >
              {proof}
              <button disabled={busy || !status.encryptionAvailable}>
                Configurar autenticador
              </button>
              {!status.encryptionAvailable && (
                <p>
                  La administración debe configurar el cifrado del servidor.
                </p>
              )}
            </form>
          )}
          {setup && (
            <>
              <p>Escanea el código con tu aplicación de autenticación.</p>
              <img
                className="mfa-qr"
                src={setup.qr}
                alt="Código QR para configurar la autenticación en dos pasos"
              />
              <Field label="Clave para introducir manualmente">
                <input readOnly value={setup.secret} autoComplete="off" />
              </Field>
              <form
                onSubmit={(e) =>
                  void perform(e, "/account/mfa/enable", (result) => {
                    setCodes(result.recoveryCodes);
                    setSetup(null);
                  })
                }
              >
                <Field label="Código de verificación">
                  <input
                    name="otp"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    autoComplete="one-time-code"
                    required
                  />
                </Field>
                <button className="primary" disabled={busy}>
                  Activar verificación
                </button>
              </form>
              <button onClick={() => setSetup(null)}>
                Cancelar configuración
              </button>
            </>
          )}
          {status.mfaEnabled && (
            <form
              onSubmit={(e) => {
                if (
                  !confirm(
                    "¿Desactivar la verificación en dos pasos de tu cuenta?",
                  )
                ) {
                  e.preventDefault();
                  return;
                }
                void perform(e, "/account/mfa/disable");
              }}
            >
              {proof}
              <button className="danger" disabled={busy}>
                Desactivar verificación
              </button>
            </form>
          )}
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Códigos de recuperación</h2>
          <p>
            Permiten recuperar la contraseña o acceder si pierdes el
            autenticador. Cada código sirve una sola vez. Guarda una copia
            privada fuera de esta aplicación.
          </p>
          <p>{status.recoveryCodesRemaining} códigos disponibles.</p>
        </div>
        <form
          onSubmit={(e) =>
            void perform(e, "/account/recovery-codes", (result) =>
              setCodes(result.recoveryCodes),
            )
          }
        >
          {proof}
          <button disabled={busy}>Generar nuevos códigos</button>
          <small>Los códigos anteriores dejarán de funcionar.</small>
        </form>
      </section>
      {codes.length > 0 && (
        <section
          className="recovery-codes"
          aria-label="Tus nuevos códigos de recuperación"
        >
          <h2>Guarda estos códigos</h2>
          <p>Solo se muestran durante esta sesión de configuración.</p>
          <pre>{codes.join("\n")}</pre>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([codes.join("\n")], { type: "text/plain" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "kelvin-recovery-codes.txt";
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={16} />
            Descargar códigos
          </button>
          <button onClick={() => setCodes([])}>Ya los he guardado</button>
        </section>
      )}
    </>
  );
}
