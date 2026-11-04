import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automations";
import { processReminders } from "../server/reminders";
import { deliverNotifications } from "../server/notification-delivery";
import { defaultNotificationSettings } from "../shared/notifications";
import {
  reminderSchema,
  resolveReminderTime,
  reminderLocalTime,
  reminderOccurrence,
  editedReminderInstant,
} from "../shared/reminders";
import { canRead } from "../server/permissions";
import type { Resource } from "../shared/model";

test("metadata edits retain exact sub-minute instants and the correct occurrence of repeated local hours", () => {
  for (const [at, occurrence] of [
    ["2026-10-25T00:30:12.345Z", "earlier"],
    ["2026-10-25T01:30:47.901Z", "later"],
  ] as const) {
    assert.equal(reminderOccurrence(at, "Europe/Madrid"), occurrence);
    assert.equal(
      editedReminderInstant(
        at,
        "Europe/Madrid",
        "2026-10-25T02:30",
        "Europe/Madrid",
        occurrence,
      ),
      at,
    );
    assert.equal(
      editedReminderInstant(
        at,
        "Europe/Madrid",
        "2026-10-25T03:00",
        "Europe/Madrid",
        occurrence,
      ),
      "2026-10-25T02:00:00.000Z",
    );
  }
  assert.equal(
    editedReminderInstant(
      "2026-10-25T00:30:12.345Z",
      "Europe/Madrid",
      "2026-10-25T02:30",
      "Europe/Madrid",
      "later",
    ),
    "2026-10-25T01:30:00.000Z",
  );
});

test("reminder time selection preserves explicit repeated-hour choice and rejects nonexistent local time", () => {
  assert.equal(
    resolveReminderTime("2026-10-25T02:30", "Europe/Madrid", "earlier").at,
    "2026-10-25T00:30:00.000Z",
  );
  assert.equal(
    resolveReminderTime("2026-10-25T02:30", "Europe/Madrid", "later").at,
    "2026-10-25T01:30:00.000Z",
  );
  assert.equal(
    resolveReminderTime("2026-10-25T02:30", "Europe/Madrid").ambiguous,
    true,
  );
  assert.throws(
    () => resolveReminderTime("2026-03-29T02:30", "Europe/Madrid"),
    /no existe/,
  );
  assert.equal(
    resolveReminderTime("2026-11-03T18:15", "Asia/Kathmandu").at,
    "2026-11-03T12:30:00.000Z",
  );
  assert.equal(
    reminderLocalTime("2026-11-03T12:30:00.000Z", "Asia/Kathmandu"),
    "2026-11-03T18:15",
  );
  assert.throws(() => resolveReminderTime("2026-02-30T12:00", "UTC"));
  assert.throws(() => resolveReminderTime("2026-11-03T12:00", "Invalid/Zone"));
});
test("reminder schedules require canonical bounded instants, valid zones and revision identifiers", () => {
  const value = {
    at: "2026-11-03T12:00:00.000Z",
    timeZone: "UTC",
    enabled: true,
    revisionId: randomUUID(),
  };
  assert.equal(reminderSchema.safeParse(value).success, true);
  for (const patch of [
    { at: "2026-11-03T12:00:00+00:00" },
    { at: "2100-01-01T00:00:00.000Z" },
    { timeZone: "invalid" },
    { revisionId: "arbitrary" },
    { delivered: true },
  ])
    assert.equal(
      reminderSchema.safeParse({ ...value, ...patch }).success,
      false,
    );
});

test("uppercase schedule identifiers normalize before delivery deduplication", async () => {
  await preferences(defaultNotificationSettings());
  const revisionId = randomUUID();
  const reminder = await make("reminder", {
    reminder: { ...schedule(), revisionId: revisionId.toUpperCase() },
  });
  assert.equal(reminder.data.reminder.revisionId, revisionId);
  await processReminders(db, now);
  await processReminders(db, now);
  assert.equal((await notifications(reminder.id)).length, 1);
});

test("delivery history retains processed schedule identities across schema upgrades and rejects their reuse", async () => {
  await preferences(defaultNotificationSettings());
  let reminder = await make("reminder", { reminder: schedule() });
  const originalSchedule = reminder.data.reminder;
  await processReminders(db, now);
  await db.query(
    "ALTER TABLE reminder_deliveries DROP CONSTRAINT reminder_deliveries_pkey, ADD PRIMARY KEY(reminder_id)",
  );
  await migrate(db);
  assert.equal(
    (
      await db.query("SELECT * FROM reminder_deliveries WHERE reminder_id=$1", [
        reminder.id,
      ])
    ).rows.length,
    1,
  );
  reminder = await make(
    "reminder",
    { ...reminder.data, reminder: schedule() },
    reminder,
  );
  await processReminders(db, now);
  assert.equal(
    (
      await db.query("SELECT * FROM reminder_deliveries WHERE reminder_id=$1", [
        reminder.id,
      ])
    ).rows.length,
    2,
  );
  assert.equal((await notifications(reminder.id)).length, 2);
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation(
          "reminder",
          { ...reminder.data, reminder: originalSchedule },
          reminder,
        ),
      )
    ).statusCode,
    409,
  );
  await processReminders(db, now);
  assert.equal((await notifications(reminder.id)).length, 2);
});

let db: Database,
  app: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  owner: string,
  peer: string,
  ownerId: string,
  peerId: string;
const headers = {
  origin: "http://reminders.test",
  "x-kelvin-client": "web",
  "x-kelvin-document-schema": "1",
};
const call = (method: any, path: string, payload?: any, cookie = owner) =>
  app.app.inject({
    method,
    url: path.startsWith("/api")
      ? path
      : `/api/workspaces/${workspaceId}${path}`,
    payload,
    headers: { ...headers, cookie },
  });
const at = "2026-11-02T23:00:00.000Z",
  now = new Date(at);
const schedule = (enabled = true, date = at) => ({
  at: date,
  timeZone: "UTC",
  enabled,
  revisionId: randomUUID(),
});
const mutation = (
  kind: string,
  data: any,
  resource?: Resource,
  title = "Personal reminder fixture",
) => ({
  operationId: randomUUID(),
  id: resource?.id || randomUUID(),
  expectedVersion: resource?.version || 0,
  kind,
  title,
  data,
});
async function make(
  kind: string,
  data: any,
  previous?: Resource,
  cookie = owner,
  title = "Personal reminder fixture",
) {
  const input = mutation(kind, data, previous, title),
    response = await call("POST", "/mutate", input, cookie);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
async function preferences(value: any) {
  const current = (await call("GET", "/api/notification-settings")).json();
  const response = await call("PUT", "/api/notification-settings", {
    settings: value,
    expectedVersion: current.version,
  });
  assert.equal(response.statusCode, 200, response.body);
}
const notifications = async (id: string) =>
  (
    await db.query<Resource>(
      "SELECT * FROM resources WHERE kind='notification' AND data->>'targetId'=$1",
      [id],
    )
  ).rows;
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  app = await createApp(db, {
    origin: headers.origin,
    setupToken: "reminders-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await call(
    "POST",
    "/api/setup",
    {
      email: "reminder-owner@example.test",
      name: "Reminder owner",
      password: "reminders-password-long",
      workspaceName: "Reminder tests",
      setupToken: "reminders-setup",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  owner = String(setup.headers["set-cookie"]).split(";")[0];
  const profile = (await call("GET", "/api/me")).json();
  ownerId = profile.user.id;
  workspaceId = profile.workspaces[0].id;
  const invitation = await call("POST", "/invitations", {
    email: "reminder-peer@example.test",
    role: "admin",
  });
  const accepted = await call(
    "POST",
    "/api/invitations/accept",
    {
      email: "reminder-peer@example.test",
      name: "Other administrator",
      password: "reminders-password-long",
      token: new URL(invitation.json().url).searchParams.get("invitation"),
    },
    "",
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  peer = String(accepted.headers["set-cookie"]).split(";")[0];
  peerId = (await call("GET", "/api/me", undefined, peer)).json().user.id;
});
after(async () => {
  await app.app.close();
  await db.close();
});
test("personal reminders acquire immutable ownership and hide records, versions and delivery status from other administrators", async () => {
  const reminder = await make("reminder", { reminder: schedule() });
  assert.equal(reminder.data.ownerId, ownerId);
  assert.equal(
    (await call("GET", "/resources", undefined, peer))
      .json()
      .resources.some((item: Resource) => item.id === reminder.id),
    false,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/resources/${reminder.id}/location`,
        undefined,
        peer,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", `/resources/${reminder.id}/versions`, undefined, peer))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation("reminder", { ...reminder.data, ownerId: peerId }, reminder),
        peer,
      )
    ).statusCode,
    403,
  );
  const legacy = {
    ...reminder,
    data: { ...reminder.data, ownerId: undefined },
  };
  assert.equal(canRead(legacy, peerId, "admin", [legacy]), false);
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation(
          "reminder",
          { ...reminder.data, ownerId: undefined },
          reminder,
        ),
      )
    ).statusCode,
    403,
  );
});
test("reminder validation rejects foreign ownership, server delivery fields, unsupported targets and unchanged schedule identities", async () => {
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation("reminder", { ownerId: peerId, reminder: schedule() }),
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", "/mutate", mutation("task", { reminder: schedule() })))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation("reminder", { reminder: { ...schedule(), deliveredAt: at } }),
      )
    ).statusCode,
    400,
  );
  const reminder = await make("reminder", {
    reminder: schedule(),
    description: "Original",
  });
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation(
          "reminder",
          { ...reminder.data, description: "Changed" },
          reminder,
        ),
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        mutation("reminder", { reminder: schedule(), targetId: reminder.id }),
      )
    ).statusCode,
    400,
  );
});
test("due reminders deliver once across retries and a recreated worker; command replay does not create another reminder", async () => {
  await preferences(defaultNotificationSettings());
  const input = mutation("reminder", { reminder: schedule() });
  const first = await call("POST", "/mutate", input);
  assert.equal(first.statusCode, 200);
  const reminder = first.json().resource;
  assert.equal(
    (await call("POST", "/mutate", input)).json().resource.id,
    reminder.id,
  );
  await Promise.all([processReminders(db, now), processReminders(db, now)]);
  await new AutomationEngine(db).tick(now, workspaceId);
  assert.equal((await notifications(reminder.id)).length, 1);
  assert.equal(
    (await call("GET", "/reminders/status"))
      .json()
      .deliveries.find((item: any) => item.reminderId === reminder.id).status,
    "delivered",
  );
  assert.equal(
    (await call("GET", "/reminders/status", undefined, peer))
      .json()
      .deliveries.some((item: any) => item.reminderId === reminder.id),
    false,
  );
});
test("quiet reminders retain a no-op save but cancellation immediately removes pending delivery", async () => {
  const settings = defaultNotificationSettings();
  settings.quiet.enabled = true;
  await preferences(settings);
  let reminder = await make("reminder", { reminder: schedule() });
  await processReminders(db, now);
  assert.equal(
    (await call("GET", "/reminders/status"))
      .json()
      .deliveries.find((item: any) => item.reminderId === reminder.id).status,
    "queued",
  );
  reminder = await make("reminder", reminder.data, reminder);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM notification_queue WHERE payload->'sourceReminder'->>'id'=$1",
        [reminder.id],
      )
    ).rows.length,
    1,
  );
  reminder = await make(
    "reminder",
    { ...reminder.data, reminder: schedule(false) },
    reminder,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM notification_queue WHERE payload->'sourceReminder'->>'id'=$1",
        [reminder.id],
      )
    ).rows.length,
    0,
  );
  await deliverNotifications(db, new Date("2026-11-03T08:00:00Z"));
  assert.equal((await notifications(reminder.id)).length, 0);
});
test("rescheduling replaces an old quiet delivery and only the new revision can notify", async () => {
  const settings = defaultNotificationSettings();
  settings.quiet.enabled = true;
  await preferences(settings);
  let reminder = await make("reminder", { reminder: schedule() });
  await processReminders(db, now);
  reminder = await make(
    "reminder",
    { ...reminder.data, reminder: schedule(true, "2026-11-03T12:00:00.000Z") },
    reminder,
  );
  await deliverNotifications(db, new Date("2026-11-03T08:00:00Z"));
  assert.equal((await notifications(reminder.id)).length, 0);
  await processReminders(db, new Date("2026-11-03T11:59:59Z"));
  assert.equal((await notifications(reminder.id)).length, 0);
  await processReminders(db, new Date("2026-11-03T12:00:00Z"));
  assert.equal((await notifications(reminder.id)).length, 1);
});
test("disabled reminder preferences suppress once until an explicit new schedule is saved", async () => {
  const settings = defaultNotificationSettings();
  settings.categories.reminder = false;
  await preferences(settings);
  let reminder = await make("reminder", { reminder: schedule() });
  await processReminders(db, now);
  assert.equal(
    (await call("GET", "/reminders/status"))
      .json()
      .deliveries.find((item: any) => item.reminderId === reminder.id).status,
    "suppressed",
  );
  await preferences(defaultNotificationSettings());
  await processReminders(db, now);
  assert.equal((await notifications(reminder.id)).length, 0);
  reminder = await make(
    "reminder",
    { ...reminder.data, reminder: schedule() },
    reminder,
  );
  await processReminders(db, now);
  assert.equal((await notifications(reminder.id)).length, 1);
});
test("target privacy is checked both at due processing and after a quiet-hour deferral", async () => {
  for (const quiet of [false, true]) {
    const settings = defaultNotificationSettings();
    settings.quiet.enabled = quiet;
    await preferences(settings);
    let target = await make("document", {}, undefined, peer);
    const reminder = await make("reminder", {
      reminder: schedule(),
      targetId: target.id,
    });
    if (quiet) await processReminders(db, now);
    target = await make("document", { ownerId: peerId }, target, peer);
    await processReminders(db, now);
    await deliverNotifications(db, new Date("2026-11-03T08:00:00Z"));
    assert.equal((await notifications(reminder.id)).length, 0);
    assert.equal(
      (await call("GET", "/resources"))
        .json()
        .resources.some((item: Resource) => item.id === reminder.id),
      false,
    );
  }
});
test("trash restoration stays disabled until explicitly reactivated with a fresh schedule", async () => {
  await preferences(defaultNotificationSettings());
  let reminder = await make("reminder", { reminder: schedule() });
  const trashed = await call("POST", "/mutate", {
    ...mutation(
      "reminder",
      { ...reminder.data, reminder: schedule(false) },
      reminder,
    ),
    deleted: true,
  });
  assert.equal(trashed.statusCode, 200, trashed.body);
  reminder = await make(
    "reminder",
    { ...trashed.json().resource.data, reminder: schedule(false) },
    trashed.json().resource,
  );
  await processReminders(db, now);
  assert.equal((await notifications(reminder.id)).length, 0);
  reminder = await make(
    "reminder",
    { ...reminder.data, reminder: schedule() },
    reminder,
  );
  await processReminders(db, now);
  assert.equal((await notifications(reminder.id)).length, 1);
});

test("removed membership cancels a due reminder without exposing an inbox record", async () => {
  const reminder = await make("reminder", { reminder: schedule() });
  await db.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, ownerId],
  );
  try {
    await processReminders(db, now);
    assert.equal((await notifications(reminder.id)).length, 0);
  } finally {
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",
      [workspaceId, ownerId],
    );
  }
});
test("a viewer can read a previously scheduled personal delivery but cannot create or change reminders", async () => {
  await preferences(defaultNotificationSettings());
  const reminder = await make("reminder", { reminder: schedule() });
  await db.query(
    "UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, ownerId],
  );
  try {
    assert.equal(
      (
        await call(
          "POST",
          "/mutate",
          mutation("reminder", { reminder: schedule() }),
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/mutate",
          mutation(
            "reminder",
            { ...reminder.data, reminder: schedule(false) },
            reminder,
          ),
        )
      ).statusCode,
      403,
    );
    await processReminders(db, now);
    assert.equal((await notifications(reminder.id)).length, 1);
    assert.equal(
      (await call("GET", "/reminders/status"))
        .json()
        .deliveries.some((item: any) => item.reminderId === reminder.id),
      true,
    );
  } finally {
    await db.query(
      "UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
      [workspaceId, ownerId],
    );
  }
});
