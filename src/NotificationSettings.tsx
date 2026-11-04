import { useState } from "react";
import { api, send } from "./api";
import { Field } from "./components/Primitives";
import { useLocalGuard } from "./useLocalGuard";
import {
  notificationCategories,
  notificationLabels,
  notificationSettingsSchema,
  notificationDraftSchema,
  storedNotificationSettings,
  type NotificationSettings as Settings,
} from "../shared/notifications";

type Snapshot = { settings: Settings; version: number };
export default function NotificationSettings({
  userId,
  preferences,
  saved,
}: {
  userId: string;
  preferences: any;
  saved: (patch: any) => void;
}) {
  const [value, setValue] = useState<Snapshot>(() => ({
    settings: storedNotificationSettings(preferences),
    version: preferences.notificationSettingsVersion || 0,
  }));
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  useLocalGuard(
    busy ? "Espera a que termine el guardado de las preferencias." : "",
  );
  const settings = value.settings;
  const patch = (next: Partial<Settings>) => {
    setValue((before) => ({
      ...before,
      settings: { ...before.settings, ...next },
    }));
    setDirty(true);
    setMessage("");
  };
  const quiet = (next: Partial<Settings["quiet"]>) =>
    patch({ quiet: { ...settings.quiet, ...next } });
  const apply = async (reload = false) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (!navigator.onLine)
        throw new Error(
          "Sin conexión. Guarda las preferencias al volver a conectarte.",
        );
      const validated = notificationSettingsSchema.safeParse(settings);
      if (!reload && !validated.success)
        throw new Error("Revisa el horario: las horas deben ser diferentes, la zona horaria debe ser válida y debes seleccionar al menos un día.");
      const result = reload
        ? await api<Snapshot>("/notification-settings")
        : await api<Snapshot>(
            "/notification-settings",
            send(
              {
                settings: validated.success ? validated.data : settings,
                expectedVersion: value.version,
              },
              "PUT",
            ),
          );
      setValue({ settings: result.settings, version: result.version });
      saved({
        notificationSettings: result.settings,
        notificationSettingsVersion: result.version,
      });
      setDirty(false);
      setMessage(
        reload
          ? "Preferencias del servidor cargadas."
          : "Preferencias de notificaciones guardadas.",
      );
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-section notification-settings"
      aria-label="Preferencias de notificaciones"
    >
      <div>
        <h2>Notificaciones</h2>
        <p>
          Elige qué llega a tu bandeja y cuándo. Estas preferencias se aplican a
          tu cuenta en todos los espacios.
        </p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <fieldset disabled={busy}>
          <legend>Tu bandeja de entrada</legend>
          <label className="checklist-item">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            Recibir notificaciones internas
          </label>
          <p className="muted">
            Las notificaciones ya entregadas se conservan. Al desactivar un
            tipo, se cancelan también sus entregas pendientes.
          </p>
          <div className="notification-categories">
            {notificationCategories.map((category) => (
              <label key={category} className="checklist-item">
                <input
                  type="checkbox"
                  checked={settings.categories[category]}
                  onChange={(event) =>
                    patch({
                      categories: {
                        ...settings.categories,
                        [category]: event.target.checked,
                      },
                    })
                  }
                />
                {notificationLabels[category]}
              </label>
            ))}
          </div>
          <fieldset className="notification-quiet">
            <legend>Horas de silencio</legend>
            <label className="checklist-item">
              <input
                type="checkbox"
                checked={settings.quiet.enabled}
                onChange={(event) => quiet({ enabled: event.target.checked })}
              />
              Aplazar durante las horas de silencio
            </label>
            <p className="muted">
              Los avisos se guardan en el servidor y llegan cuando termina este
              horario, si sigues teniendo acceso. El proceso los revisa cada 15
              segundos mientras la aplicación está funcionando.
            </p>
            <div className="form-grid">
              <Field label="Inicio del silencio">
                <input
                  type="time"
                  required
                  value={settings.quiet.start}
                  onChange={(event) => quiet({ start: event.target.value })}
                />
              </Field>
              <Field label="Fin del silencio">
                <input
                  type="time"
                  required
                  value={settings.quiet.end}
                  onChange={(event) => quiet({ end: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Zona horaria del silencio">
              <input
                required
                maxLength={80}
                value={settings.quiet.timeZone}
                onChange={(event) => quiet({ timeZone: event.target.value })}
                aria-describedby="notification-zone-help"
              />
            </Field>
            <p id="notification-zone-help" className="muted">
              Por ejemplo, Europe/Madrid. Si el horario cruza medianoche, los
              días indican cuándo empieza.
            </p>
            <fieldset className="notification-days">
              <legend>Días de inicio</legend>
              {[
                "Domingo",
                "Lunes",
                "Martes",
                "Miércoles",
                "Jueves",
                "Viernes",
                "Sábado",
              ].map((day, index) => (
                <label className="checklist-item" key={day}>
                  <input
                    type="checkbox"
                    checked={settings.quiet.days.includes(index)}
                    onChange={(event) =>
                      quiet({
                        days: event.target.checked
                          ? [...settings.quiet.days, index].sort()
                          : settings.quiet.days.filter(
                              (value) => value !== index,
                            ),
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </fieldset>
          </fieldset>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <p role="status">
          {message || (dirty ? "Cambios sin guardar." : "")}
        </p>
        <div className="notification-actions">
          <button className="primary" disabled={busy || !dirty}>
            Guardar preferencias de notificaciones
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply(true)}
          >
            Descartar cambios y cargar del servidor
          </button>
        </div>
        <p className="muted">
          Canal disponible: bandeja interna. El correo y las notificaciones push
          siguen pendientes de integración. Los cambios se aplican a nuevos
          avisos y entregas pendientes, sin eliminar el historial.
        </p>
      </form>
    </section>
  );
}
