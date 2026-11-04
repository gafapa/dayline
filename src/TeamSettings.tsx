import { Field } from "./components/Primitives";
import { useState } from "react";
import { api, send } from "./api";

export function Team({ members, workspace, refresh, error }: any) {
  const [link, setLink] = useState("");
  return (
    <>
      <div className="member-list">
        {members.map((m: any) => (
          <div className="member-row" key={m.id}>
            <span className="avatar">{m.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{m.name}</strong>
              <small>{m.email}</small>
            </div>
            {workspace.role === "admin" ? (
              <select
                aria-label={`Rol de ${m.name}`}
                value={m.role}
                onChange={async (e) => {
                  try {
                    await api(
                      `/workspaces/${workspace.id}/members/${m.id}`,
                      send({ role: e.target.value }, "PATCH"),
                    );
                    await refresh();
                  } catch (e) {
                    error((e as Error).message);
                  }
                }}
              >
                <option value="admin">Administrador</option>
                <option value="member">Miembro</option>
                <option value="viewer">Solo lectura</option>
                <option value="guest">Invitado</option>
              </select>
            ) : (
              <span>{m.role}</span>
            )}
          </div>
        ))}
      </div>
      {workspace.role === "admin" && (
        <section className="settings-section">
          <div>
            <h2>Invita a tu equipo</h2>
            <p>
              Genera un enlace personal que caduca a los siete días. Compártelo
              con la persona invitada.
            </p>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(e.currentTarget));
              try {
                setLink(
                  (
                    await api(
                      `/workspaces/${workspace.id}/invitations`,
                      send(data),
                    )
                  ).url,
                );
              } catch (e) {
                error((e as Error).message);
              }
            }}
          >
            <Field label="Correo de la persona invitada">
              <input name="email" type="email" required />
            </Field>
            <Field label="Permisos">
              <select name="role">
                <option value="member">Miembro</option>
                <option value="viewer">Solo lectura</option>
                <option value="guest">
                  Invitado a proyectos seleccionados
                </option>
              </select>
            </Field>
            <button className="primary">Generar invitación</button>
            {link && (
              <Field label="Enlace de invitación">
                <input
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
            )}
          </form>
        </section>
      )}
    </>
  );
}
