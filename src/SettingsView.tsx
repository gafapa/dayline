import { Field } from "./components/Primitives";
import { SecuritySettings } from "./SecuritySettings";
import { Suspense, lazy, useEffect, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { api, send } from "./api";
const NotificationSettings = lazy(() => import("./NotificationSettings"));
import { download } from "./ui-common";

export function SettingsView({
  user,
  workspace,
  preferences,
  updatePreference,
  notify,
  error,
  reload,
  preferencesSaved,
}: any) {
  const [area, setArea] = useState("general"),
    [ai, setAi] = useState<any>(null),
    [sessions, setSessions] = useState<any[]>([]);
  useEffect(() => {
    if (area === "ai" && workspace.role === "admin")
      api(`/workspaces/${workspace.id}/ai/settings`)
        .then(setAi)
        .catch((e) => error(e.message));
    if (area === "sessions")
      api("/sessions")
        .then((r) => setSessions(r.sessions))
        .catch((e) => error(e.message));
  }, [area, workspace.id]);
  return (
    <>
      <div className="view-tabs">
        {[
          ["general", "General"],
          ["appearance", "Apariencia"],
          ["notifications", "Notificaciones"],
          ["security", "Seguridad"],
          ["ai", "Inteligencia artificial"],
          ["data", "Datos"],
          ["sessions", "Sesiones"],
        ].map(([v, l]) => (
          <button
            className={area === v ? "active" : ""}
            key={v}
            onClick={() => setArea(v)}
          >
            {l}
          </button>
        ))}
      </div>
      {area === "security" && (
        <SecuritySettings notify={notify} error={error} />
      )}
      {area === "notifications" && (
        <Suspense fallback={<p role="status">Abriendo tus preferencias…</p>}>
          <NotificationSettings
            key={user.id}
            userId={user.id}
            preferences={preferences}
            saved={preferencesSaved}
          />
        </Suspense>
      )}
      {area === "general" && (
        <>
          <section className="settings-section">
            <div>
              <h2>Tu cuenta</h2>
              <p>Identidad y espacio de trabajo actual.</p>
            </div>
            <div className="settings-panel">
              <Field label="Nombre">
                <input readOnly value={user.name} />
              </Field>
              <Field label="Correo">
                <input readOnly value={user.email} />
              </Field>
              <Field label="Espacio">
                <input readOnly value={workspace.name} />
              </Field>
            </div>
          </section>
        </>
      )}
      {area === "appearance" && (
        <section className="settings-section">
          <div>
            <h2>Apariencia</h2>
            <p>Una interfaz cómoda durante toda la jornada.</p>
          </div>
          <div className="settings-panel">
            <Field label="Tema">
              <select
                value={preferences.theme || "system"}
                onChange={(e) =>
                  void updatePreference({ theme: e.target.value })
                }
              >
                <option value="system">Usar el del sistema</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </Field>
            <Field label="Zona horaria">
              <input
                defaultValue={
                  preferences.timeZone ||
                  Intl.DateTimeFormat().resolvedOptions().timeZone
                }
                onBlur={(e) =>
                  void updatePreference({ timeZone: e.target.value })
                }
              />
            </Field>
          </div>
        </section>
      )}
      {area === "ai" &&
        (workspace.role !== "admin" ? (
          <p>
            La configuración de IA corresponde a la administración del espacio.
          </p>
        ) : (
          ai && (
            <section className="settings-section">
              <div>
                <h2>IA opcional, por API</h2>
                <p>
                  La aplicación funciona sin IA. Cada solicitud enviará
                  únicamente el contexto que selecciones.
                </p>
                <p>
                  {ai.requestCount || 0} solicitudes en el periodo registrado.
                </p>
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  try {
                    await api(
                      `/workspaces/${workspace.id}/ai/settings`,
                      send(
                        {
                          enabled: f.get("enabled") === "on",
                          provider: f.get("provider"),
                          model: f.get("model"),
                          apiKey: f.get("apiKey") || undefined,
                          monthlyRequestLimit: Number(
                            f.get("monthlyRequestLimit"),
                          ),
                        },
                        "PUT",
                      ),
                    );
                    notify("Configuración de IA guardada.");
                  } catch (e) {
                    error((e as Error).message);
                  }
                }}
              >
                <label className="checklist-item">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={ai.enabled}
                  />
                  Habilitar IA para los miembros
                </label>
                <Field label="Proveedor">
                  <select
                    name="provider"
                    defaultValue={ai.provider || "openai-compatible"}
                  >
                    <option value="openai-compatible">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </Field>
                <Field label="Identificador del modelo">
                  <input
                    name="model"
                    required
                    defaultValue={ai.model || ""}
                    placeholder="Identificador del modelo de tu proveedor"
                  />
                </Field>
                <Field
                  label={
                    ai.hasApiKey ? "Nueva clave API (opcional)" : "Clave API"
                  }
                >
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="Límite mensual de solicitudes">
                  <input
                    type="number"
                    name="monthlyRequestLimit"
                    min="0"
                    max="100000"
                    defaultValue={ai.monthlyRequestLimit || 100}
                  />
                </Field>
                <button className="primary">Guardar configuración</button>
              </form>
            </section>
          )
        ))}
      {area === "data" && (
        <section className="settings-section">
          <div>
            <h2>Tus datos</h2>
            <p>
              Descarga los elementos a los que tienes acceso, incluido el estado
              colaborativo de los documentos.
            </p>
          </div>
          <div className="settings-panel">
            <button
              onClick={async () => {
                try {
                  const data = await api(`/workspaces/${workspace.id}/export`);
                  download(
                    "kelvin-workspace.json",
                    JSON.stringify(data, null, 2),
                    "application/json",
                  );
                } catch (e) {
                  error((e as Error).message);
                }
              }}
            >
              <ArrowDownToLine size={16} />
              Exportar espacio
            </button>
            <a
              className="export-archive"
              href={`/api/workspaces/${workspace.id}/export/archive`}
              download="kelvin-workspace.tar.gz"
            >
              <ArrowDownToLine size={16} />
              Exportar espacio completo con adjuntos
            </a>
            <button
              onClick={async () => {
                const estimate = await navigator.storage?.estimate();
                notify(
                  `Almacenamiento local: ${((estimate.usage || 0) / 1048576).toFixed(1)} MB`,
                );
              }}
            >
              Consultar almacenamiento local
            </button>
            <button
              onClick={async () => {
                const ok = await navigator.storage?.persist();
                notify(
                  ok
                    ? "Almacenamiento persistente concedido."
                    : "El navegador conserva el control sobre el almacenamiento.",
                );
              }}
            >
              Solicitar almacenamiento persistente
            </button>
          </div>
        </section>
      )}
      {area === "sessions" && (
        <section>
          <h2>Sesiones abiertas</h2>
          {sessions.map((s) => (
            <div className="document-row" key={s.id}>
              <div>
                <strong>{s.user_agent || "Dispositivo"}</strong>
                <p>Iniciada {new Date(s.created_at).toLocaleString("es")}</p>
              </div>
              <button
                onClick={async () => {
                  await api(`/sessions/${s.id}`, { method: "DELETE" });
                  setSessions(sessions.filter((v) => v.id !== s.id));
                  notify("Sesión revocada.");
                }}
              >
                Revocar
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
