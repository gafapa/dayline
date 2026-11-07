import type { Resource, User } from "../shared/model";

/** The decisions a notification can get. Shared by Bandeja and Hoy. */
export const localDay = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const tomorrowMorning = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

export const isSnoozed = (r: Resource, now = Date.now()) =>
  !!r.data.snoozedUntil && Date.parse(r.data.snoozedUntil) > now;

export function triage(resources: Resource[], user: User, save: (r: Resource) => Promise<unknown>) {
  const target = (r: Resource) =>
    r.data.targetId ? resources.find((t) => t.id === r.data.targetId && !t.deleted_at) : undefined;
  const archive = (r: Resource) => save({ ...r, data: { ...r.data, read: true } });
  /** The linked task when it is yours, open and not already due today. */
  const plannable = (r: Resource) => {
    const item = target(r);
    return item?.kind === "task" &&
      item.data.assigneeId === user.id &&
      !["done", "cancelled"].includes(item.data.status) &&
      item.data.dueDate !== localDay()
      ? item
      : undefined;
  };
  return {
    target,
    archive,
    plannable,
    planToday: async (r: Resource) => {
      const item = plannable(r);
      if (item) await save({ ...item, data: { ...item.data, dueDate: localDay() } });
      await archive(r);
    },
    /** Gives the linked task a due date and archives the notice. */
    planOn: async (r: Resource, dueDate: string) => {
      const item = plannable(r);
      if (item) await save({ ...item, data: { ...item.data, dueDate } });
      await archive(r);
    },
    snooze: (r: Resource) => save({ ...r, data: { ...r.data, snoozedUntil: tomorrowMorning() } }),
  };
}
