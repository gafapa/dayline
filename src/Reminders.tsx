import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { Resource, User, Workspace } from "../shared/model";
import {
  reminderLocalTime,
  reminderTargetKinds,
  reminderOccurrence,
  editedReminderInstant,
} from "../shared/reminders";
import { validTimeZone } from "../shared/time";
import { api } from "./api";
import { Field } from "./components/Primitives";
import { ResourceLink } from "./ResourceLink";
import { useDraft } from "./useDraft";
import { useLocalGuard } from "./useLocalGuard";
import { readUserCache, writeUserCache } from "./storage";

const formSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    title: z.string().max(500),
    description: z.string().max(2000),
    targetId: z.string(),
    local: z.string().max(20),
    timeZone: z.string().max(80),
    occurrence: z.enum(["earlier", "later"]),
    enabled: z.boolean(),
    revisionId: z.string().uuid(),
    originalAt: z.string().max(40).optional(),
    originalTimeZone: z.string().max(80).optional(),
  })
  .strict();
type Form = z.infer<typeof formSchema>;
type Delivery = {
  reminderId: string;
  revisionId: string;
  status: string;
  processedAt: string;
};
export default function Reminders({
  resources,
  user,
  workspace,
  canEdit,
  timeZone,
  focusId,
  targetId,
  startNew,
  open,
  close,
  save,
}: {
  resources: Resource[];
  user: User;
  workspace: Workspace;
  canEdit: boolean;
  timeZone: string;
  focusId: string | null;
  targetId: string | null;
  startNew: boolean;
  open: (resource: Resource) => void;
  close: (createNew?: boolean) => void;
  save: (resource: Resource) => Promise<Resource | undefined>;
}) {
  const source = resources.find(
    (resource) =>
      resource.id === focusId &&
      resource.kind === "reminder" &&
      !resource.deleted_at,
  );
  const fresh = (record?: Resource): Form => {
    const zone =
      record?.data.reminder?.timeZone ||
      (validTimeZone(timeZone) ? timeZone : "UTC");
    const at =
      record?.data.reminder?.at || new Date(Date.now() + 3600000).toISOString();
    const local = reminderLocalTime(at, zone);
    return {
      id: record?.id || crypto.randomUUID(),
      version: record?.version || 0,
      title: record?.title || "",
      description: record?.data.description || "",
      targetId: record?.data.targetId || targetId || "",
      local,
      timeZone: zone,
      occurrence: reminderOccurrence(at, zone),
      originalAt: record?.data.reminder?.at,
      originalTimeZone: record?.data.reminder?.timeZone,
      enabled: record?.data.reminder?.enabled ?? true,
      revisionId: crypto.randomUUID(),
    };
  };
  const [form, setForm] = useState(() => fresh(source)),
    [editing, setEditing] = useState(!!focusId || !!targetId || startNew),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [targetQuery, setTargetQuery] = useState(""),
    [includeStopped, setIncludeStopped] = useState(false),
    [limit, setLimit] = useState(50);
  const [delivery, setDelivery] = useState<Delivery[]>([]),
    [deliveryAt, setDeliveryAt] = useState(""),
    [deliveryIssue, setDeliveryIssue] = useState("");
  const unavailable = !!focusId && !source;
  useLocalGuard(
    busy ? "Espera a que termine la operación del recordatorio." : "",
  );
  const draft = useDraft(
    user.id,
    `${workspace.id}:reminder:${focusId || "new"}`,
    form,
    dirty,
    (value) => {
      const restored = formSchema.parse(value);
      if (source && restored.id !== source.id)
        throw new Error("Mismatched reminder draft");
      setForm(restored);
      setDirty(true);
      setEditing(true);
    },
    !unavailable,
  );
  useEffect(() => {
    if (source && !dirty) setForm(fresh(source));
  }, [source?.version, dirty]);
  useEffect(() => {
    let disposed = false;
    const key = `${workspace.id}:reminder-status-cache`;
    const load = async () => {
      try {
        const cached = await readUserCache(user.id, key);
        if (!disposed && Array.isArray(cached?.deliveries)) {
          setDelivery(cached.deliveries);
          setDeliveryAt(cached.at || "");
        }
        if (!navigator.onLine) {
          if (!disposed)
            setDeliveryIssue(
              "Estado de entrega sin actualizar: estás sin conexión.",
            );
          return;
        }
        const result = await api<{ deliveries: Delivery[] }>(
          `/workspaces/${workspace.id}/reminders/status`,
        );
        if (disposed) return;
        const at = new Date().toISOString();
        setDelivery(result.deliveries);
        setDeliveryAt(at);
        setDeliveryIssue("");
        await writeUserCache(user.id, key, { ...result, at });
      } catch {
        if (!disposed)
          setDeliveryIssue(
            "No se ha podido actualizar el estado de entrega. Se conserva la última consulta local.",
          );
      }
    };
    void load();
    const online = () => void load();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    return () => {
      disposed = true;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
    };
  }, [user.id, workspace.id, resources]);
  const patch = (value: Partial<Form>) => {
    setForm((previous) => ({ ...previous, ...value }));
    setDirty(true);
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportJSON = (value: unknown, filename: string) => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const saveForm = () =>
    perform(async () => {
      const originalAt =
        form.originalAt ||
        (source?.version === form.version
          ? source.data.reminder?.at
          : undefined);
      const originalZone =
        form.originalTimeZone ||
        (source?.version === form.version
          ? source.data.reminder?.timeZone
          : undefined);
      const instant = editedReminderInstant(
        originalAt,
        originalZone,
        form.local,
        form.timeZone,
        form.occurrence,
      );
      const record = await save({
        ...(source || {}),
        id: form.id,
        workspace_id: workspace.id,
        kind: "reminder",
        title: form.title.trim(),
        data: {
          ownerId: user.id,
          ...(form.targetId ? { targetId: form.targetId } : {}),
          description: form.description,
          reminder: {
            at: instant,
            timeZone: form.timeZone,
            revisionId: form.revisionId,
            enabled: form.enabled,
          },
        },
        version: form.version,
        created_by: source?.created_by || user.id,
        created_at: source?.created_at || new Date().toISOString(),
        updated_at: source?.updated_at || new Date().toISOString(),
        deleted_at: null,
      });
      if (!record)
        throw new Error(
          "No se pudo guardar el recordatorio. El borrador se conserva.",
        );
      await draft.clear();
      setDirty(false);
      open(record);
    });
  const updateState = (record: Resource, enabled: boolean, deleted = false) =>
    perform(async () => {
      const saved = await save({
        ...record,
        data: {
          ...record.data,
          reminder: {
            ...record.data.reminder,
            enabled,
            revisionId: crypto.randomUUID(),
          },
        },
        deleted_at: deleted ? new Date().toISOString() : null,
      });
      if (!saved)
        throw new Error("No se pudo guardar el cambio del recordatorio.");
      if (deleted) close();
    });
  const reminders = useMemo(
    () =>
      resources
        .filter(
          (record) =>
            record.kind === "reminder" &&
            record.created_by === user.id &&
            !record.deleted_at &&
            (includeStopped || record.data.reminder?.enabled) &&
            `${record.title} ${record.data.description || ""}`
              .toLocaleLowerCase("es")
              .includes(query.toLocaleLowerCase("es")),
        )
        .sort(
          (a, b) =>
            String(a.data.reminder?.at).localeCompare(
              String(b.data.reminder?.at),
            ) || a.id.localeCompare(b.id),
        ),
    [resources, user.id, query, includeStopped],
  );
  const status = (record: Resource) => {
    if (!record.data.reminder?.enabled) return "Cancelado por ti";
    const current = delivery.find(
      (item) =>
        item.reminderId === record.id &&
        item.revisionId === record.data.reminder.revisionId,
    );
    return (
      (
        {
          delivered: "Entregado en tu bandeja",
          queued: "Aplazado por horas de silencio",
          suppressed: "Omitido por tus preferencias",
          unavailable: "Cancelado por falta de acceso",
          cancelled: "Entrega cancelada",
        } as Record<string, string>
      )[current?.status || ""] ||
      "Programación guardada; entrega pendiente de consultar"
    );
  };
  const candidates = resources
    .filter(
      (record) =>
        !record.deleted_at &&
        reminderTargetKinds.has(record.kind) &&
        (record.id === form.targetId ||
          record.title
            .toLocaleLowerCase("es")
            .includes(targetQuery.toLocaleLowerCase("es"))),
    )
    .sort(
      (a, b) => Number(b.id === form.targetId) - Number(a.id === form.targetId),
    )
    .slice(0, 50);
  return (
    <div className="personal-reminders">
      <div className="reminders-intro">
        <p>
          Avisos personales de este espacio. Se entregan en tu bandeja y
          respetan tus preferencias y horas de silencio.
        </p>
        {canEdit && (
          <button
            className="primary"
            onClick={() => {
              if (focusId || targetId) close(true);
              else setEditing(true);
            }}
          >
            Nuevo recordatorio personal
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {draft.issue && <p role="alert">{draft.issue}</p>}
      {unavailable && (
        <p role="alert">Este recordatorio no está disponible para tu cuenta.</p>
      )}
      {editing && !unavailable && (
        <section
          className="reminder-composer"
          aria-label={
            source
              ? "Editar recordatorio personal"
              : "Crear recordatorio personal"
          }
        >
          <h2>{source ? "Tu próximo aviso" : "Algo que quieres recordar"}</h2>
          {source && <ResourceLink id={source.id} />}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveForm();
            }}
          >
            <fieldset disabled={!canEdit || busy || !draft.ready}>
              <Field label="Título del recordatorio">
                <input
                  required
                  maxLength={500}
                  value={form.title}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </Field>
              <Field label="Mensaje del recordatorio">
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={form.description}
                  onChange={(event) =>
                    patch({ description: event.target.value })
                  }
                />
              </Field>
              <div className="form-grid">
                <Field label="Fecha y hora del aviso">
                  <input
                    type="datetime-local"
                    required
                    min="2000-01-01T00:00"
                    max="2099-12-31T23:59"
                    value={form.local}
                    onChange={(event) => patch({ local: event.target.value })}
                  />
                </Field>
                <Field label="Zona horaria del aviso">
                  <input
                    required
                    maxLength={80}
                    value={form.timeZone}
                    onChange={(event) =>
                      patch({ timeZone: event.target.value })
                    }
                  />
                </Field>
              </div>
              <Field label="Si esta hora ocurre dos veces">
                <select
                  value={form.occurrence}
                  onChange={(event) =>
                    patch({
                      occurrence: event.target.value as Form["occurrence"],
                    })
                  }
                >
                  <option value="earlier">La primera vez</option>
                  <option value="later">La segunda vez</option>
                </select>
              </Field>
              <p className="muted">
                La fecha corresponde a la zona indicada, por ejemplo
                Europe/Madrid. La elección anterior se aplica al cambio de hora
                de otoño. Una hora inexistente se rechaza. Los avisos vencidos
                se procesan al sincronizar.
              </p>
              <Field label="Buscar elemento para vincular">
                <input
                  type="search"
                  value={targetQuery}
                  onChange={(event) => setTargetQuery(event.target.value)}
                />
              </Field>
              <Field label="Elemento vinculado al aviso">
                <select
                  value={form.targetId}
                  onChange={(event) => patch({ targetId: event.target.value })}
                >
                  <option value="">Sin vínculo</option>
                  {candidates.map((record) => (
                    <option key={record.id} value={record.id}>
                      {record.title.slice(0, 100)}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="checklist-item">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => patch({ enabled: event.target.checked })}
                />
                Programación activa
              </label>
            </fieldset>
            <p role="status">
              {dirty
                ? draft.saved
                  ? "Borrador de recordatorio guardado en este dispositivo."
                  : "Guardando el borrador del recordatorio…"
                : source
                  ? status(source)
                  : ""}
            </p>
            <div className="reminder-actions">
              <button
                className="primary"
                disabled={
                  !canEdit ||
                  busy ||
                  !draft.ready ||
                  !form.title.trim() ||
                  (!!source && !dirty)
                }
              >
                Guardar recordatorio personal
              </button>
              <button
                type="button"
                onClick={() =>
                  exportJSON(
                    { type: "personal-reminder-draft", value: form },
                    "recordatorio-borrador.json",
                  )
                }
              >
                Exportar borrador de recordatorio
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await draft.clear();
                    setDirty(false);
                    setForm(fresh(source));
                    if (!source) setEditing(false);
                  })
                }
              >
                Descartar borrador de recordatorio
              </button>
            </div>
            {source && canEdit && (
              <div className="reminder-actions">
                <button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() =>
                    void updateState(source, !source.data.reminder.enabled)
                  }
                >
                  {source.data.reminder.enabled
                    ? "Cancelar aviso"
                    : "Reactivar aviso"}
                </button>
                <button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => {
                    if (confirm(`¿Mover «${source.title}» a la papelera?`))
                      void updateState(source, false, true);
                  }}
                >
                  Eliminar recordatorio
                </button>
              </div>
            )}
            {source?.data.targetId &&
              resources.find(
                (record) =>
                  record.id === source.data.targetId && !record.deleted_at,
              ) && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    open(
                      resources.find(
                        (record) => record.id === source.data.targetId,
                      )!,
                    )
                  }
                >
                  Abrir elemento vinculado
                </button>
              )}
          </form>
        </section>
      )}
      <section
        className="reminder-list"
        aria-label="Mis recordatorios personales"
      >
        <div className="reminder-filters">
          <Field label="Buscar recordatorios">
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(50);
              }}
            />
          </Field>
          <label className="checklist-item">
            <input
              type="checkbox"
              checked={includeStopped}
              onChange={(event) => {
                setIncludeStopped(event.target.checked);
                setLimit(50);
              }}
            />
            Incluir cancelados
          </label>
        </div>
        <p role="status">
          {reminders.length}{" "}
          {reminders.length === 1
            ? "recordatorio personal"
            : "recordatorios personales"}
        </p>
        {deliveryIssue && <p className="muted">{deliveryIssue}</p>}
        {deliveryAt && (
          <p className="muted">
            Última consulta de entregas:{" "}
            {new Date(deliveryAt).toLocaleString("es")}
          </p>
        )}
        {reminders.slice(0, limit).map((record) => (
          <article className="reminder-row" key={record.id}>
            <div>
              <button className="text-button" onClick={() => open(record)}>
                {record.title}
              </button>
              <p>
                {new Date(record.data.reminder.at).toLocaleString("es", {
                  timeZone: record.data.reminder.timeZone,
                })}{" "}
                · {record.data.reminder.timeZone}
              </p>
              <p>{status(record)}</p>
              <small>Solo tu cuenta</small>
            </div>
            {canEdit && (
              <button
                disabled={busy || dirty}
                onClick={() =>
                  void updateState(record, !record.data.reminder.enabled)
                }
              >
                {record.data.reminder.enabled ? "Cancelar" : "Reactivar"}
              </button>
            )}
          </article>
        ))}
        {!reminders.length && (
          <p className="quiet-empty">
            No hay recordatorios que coincidan con este filtro.
          </p>
        )}
        {reminders.length > limit && (
          <button onClick={() => setLimit((value) => value + 50)}>
            Mostrar 50 recordatorios más
          </button>
        )}
        <button
          className="text-button"
          onClick={() => exportJSON(reminders, "recordatorios-personales.json")}
        >
          Exportar recordatorios filtrados
        </button>
      </section>
      <p className="muted">
        La entrega se realiza en el servidor mientras la aplicación está
        funcionando. No es una alarma del dispositivo ni un aviso push. Solo tu
        cuenta puede ver estos recordatorios.
      </p>
    </div>
  );
}
