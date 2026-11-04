import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automations";
import {
  scheduleNotification,
  deliverNotifications,
} from "../server/notification-delivery";
import {
  defaultNotificationSettings,
  notificationSettingsSchema,
  nextNotificationTime,
} from "../shared/notifications";
import type { Resource } from "../shared/model";

test("quiet hours respect selected start days, overnight boundaries and seconds", () => {
  const settings = defaultNotificationSettings();
  settings.quiet = {
    enabled: true,
    start: "22:00",
    end: "08:00",
    days: [1],
    timeZone: "UTC",
  };
  for (const [now, expected] of [
    ["2026-11-02T21:59:59Z", "2026-11-02T21:59:59.000Z"],
    ["2026-11-02T22:00:00Z", "2026-11-03T08:00:00.000Z"],
    ["2026-11-03T07:59:59Z", "2026-11-03T08:00:00.000Z"],
    ["2026-11-03T08:00:00Z", "2026-11-03T08:00:00.000Z"],
    ["2026-11-03T23:00:00Z", "2026-11-03T23:00:00.000Z"],
  ])
    assert.equal(
      nextNotificationTime(settings, new Date(now)).toISOString(),
      expected,
    );
});
test("quiet schedules resolve spring gaps and repeated autumn hours to the first available UTC minute", () => {
  const settings = defaultNotificationSettings("Europe/Madrid");
  settings.quiet = {
    enabled: true,
    start: "01:00",
    end: "02:30",
    days: [0],
    timeZone: "Europe/Madrid",
  };
  assert.equal(
    nextNotificationTime(
      settings,
      new Date("2026-03-29T00:30:00Z"),
    ).toISOString(),
    "2026-03-29T01:00:00.000Z",
  );
  assert.equal(
    nextNotificationTime(
      settings,
      new Date("2026-10-25T00:10:00Z"),
    ).toISOString(),
    "2026-10-25T00:30:00.000Z",
  );
  assert.equal(
    nextNotificationTime(
      settings,
      new Date("2026-10-25T01:10:00Z"),
    ).toISOString(),
    "2026-10-25T01:30:00.000Z",
  );
  settings.quiet.start = "08:00";
  settings.quiet.end = "12:00";
  assert.equal(
    nextNotificationTime(
      settings,
      new Date("2026-11-01T08:00:01Z"),
    ).toISOString(),
    "2026-11-01T11:00:00.000Z",
  );
});
test("notification preferences reject ambiguous schedules, unsupported fields and zones", () => {
  const settings = defaultNotificationSettings();
  assert.equal(
    notificationSettingsSchema.safeParse({ ...settings, email: true }).success,
    false,
  );
  for (const quiet of [
    { timeZone: "Invalid/Zone" },
    { days: [] },
    { days: [1, 1] },
    { enabled: true, start: "22:00", end: "22:00" },
    { start: "25:00" },
  ])
    assert.equal(
      notificationSettingsSchema.safeParse({
        ...settings,
        quiet: { ...settings.quiet, ...quiet },
      }).success,
      false,
    );
});

let db: Database,
  app: Awaited<ReturnType<typeof createApp>>,
  owner: string,
  member: string,
  ownerId: string,
  memberId: string,
  workspaceId: string;
const headers = {
  origin: "http://notification.test",
  "x-kelvin-client": "web",
  "x-kelvin-document-schema": "1",
};
const call = (method: any, url: string, payload?: any, cookie = owner) =>
  app.app.inject({
    method,
    url: `/api${url}`,
    payload,
    headers: { ...headers, cookie },
  });
async function make(
  kind: string,
  data: any = {},
  title = "Notification fixture",
  previous?: Resource,
) {
  const response = await call("POST", `/workspaces/${workspaceId}/mutate`, {
    operationId: randomUUID(),
    id: previous?.id || randomUUID(),
    expectedVersion: previous?.version || 0,
    kind,
    title,
    data,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
async function put(settings: any, cookie = member, version?: number) {
  const current = (
    await call("GET", "/notification-settings", undefined, cookie)
  ).json();
  return call(
    "PUT",
    "/notification-settings",
    { settings, expectedVersion: version ?? current.version },
    cookie,
  );
}
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  app = await createApp(db, {
    origin: headers.origin,
    setupToken: "notification-test-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await call(
    "POST",
    "/setup",
    {
      email: "notification-owner@example.test",
      name: "Owner",
      password: "notification-password-long",
      workspaceName: "Notification tests",
      setupToken: "notification-test-setup",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  owner = String(setup.headers["set-cookie"]).split(";")[0];
  const profile = (await call("GET", "/me")).json();
  ownerId = profile.user.id;
  workspaceId = profile.workspaces[0].id;
  const invitation = await call(
    "POST",
    `/workspaces/${workspaceId}/invitations`,
    { email: "notification-member@example.test", role: "member" },
  );
  const accepted = await call(
    "POST",
    "/invitations/accept",
    {
      email: "notification-member@example.test",
      name: "Recipient",
      password: "notification-password-long",
      token: new URL(invitation.json().url).searchParams.get("invitation"),
    },
    "",
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  member = String(accepted.headers["set-cookie"]).split(";")[0];
  memberId = (await call("GET", "/me", undefined, member)).json().user.id;
});
afterEach(async () => {
  if (db) {
    await db.query("DELETE FROM notification_queue");
    await db.query("DELETE FROM user_preferences");
  }
});
after(async () => {
  await app.app.close();
  await db.close();
});

test("ordinary assignment writes enter the durable quiet queue instead of publishing an inbox row", async () => {
  const now = new Date(), settings = defaultNotificationSettings();
  settings.quiet.enabled = true;
  settings.quiet.start = new Date(now.getTime() - 60000).toISOString().slice(11, 16);
  settings.quiet.end = new Date(now.getTime() + 3600000).toISOString().slice(11, 16);
  await put(settings);
  const target = await make("task", { status: "todo", assigneeId: memberId });
  const pending = (await db.query("SELECT * FROM notification_queue WHERE payload->'data'->>'targetId'=$1", [target.id])).rows;
  assert.equal(pending.length, 1);
  assert.equal((await db.query("SELECT id FROM resources WHERE kind='notification' AND data->>'targetId'=$1", [target.id])).rows.length, 0);
  await deliverNotifications(db, new Date(now.getTime() + 3 * 3600000));
  assert.equal((await db.query("SELECT id FROM resources WHERE id=$1", [pending[0].id])).rows.length, 1);
});

test("delayed daily summaries recompute permission-scoped counts and paused source rules cancel pending deliveries", async () => {
  const label = randomUUID(), settings = defaultNotificationSettings(); settings.quiet.enabled = true; await put(settings);
  const project = await make("project", {});
  await make("task", { labels: [label], status: "todo", projectId: project.id });
  await make("task", { labels: [label], status: "todo" });
  let rule = await make("automation", { enabled: true, trigger: "daily_summary", action: "notify", actionValue: memberId, matchLabel: label, timeZone: "UTC", timeOfDay: "22:00" }, "Deferred daily summary");
  await app.automations.tick(frozen, workspaceId);
  const first = (await db.query("SELECT * FROM notification_queue WHERE payload->'sourceRule'->>'id'=$1", [rule.id])).rows[0];
  assert.ok(first);
  assert.match(first.payload.data.description, /2 pendientes/);
  await make("project", { private: true, members: [] }, project.title, project);
  await deliverNotifications(db, delivery);
  const delivered = (await db.query("SELECT * FROM resources WHERE id=$1", [first.id])).rows[0];
  assert.match(delivered.data.description, /1 pendientes/);
  assert.equal((await db.query("SELECT * FROM resource_versions WHERE resource_id=$1", [first.id])).rows.length, 1);
  await app.automations.tick(new Date("2026-11-03T23:00:00Z"), workspaceId);
  const second = (await db.query("SELECT * FROM notification_queue WHERE payload->'sourceRule'->>'id'=$1", [rule.id])).rows[0];
  assert.ok(second);
  rule = await make("automation", { ...rule.data, enabled: false }, rule.title, rule);
  await deliverNotifications(db, new Date("2026-11-04T08:00:00Z"));
  assert.equal((await db.query("SELECT id FROM resources WHERE id=$1", [second.id])).rows.length, 0);
  assert.equal((await db.query("SELECT id FROM notification_queue WHERE id=$1", [second.id])).rows.length, 0);
});

test("settings are account scoped, versioned and retryable without overwriting another session", async () => {
  const original = (
    await call("GET", "/notification-settings", undefined, member)
  ).json();
  const settings = { ...original.settings, enabled: false };
  const first = await put(settings, member, 0);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().version, 1);
  const replay = await put(settings, member, 0);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replay, true);
  assert.equal((await put(original.settings, member, 0)).statusCode, 409);
  assert.equal(
    (await call("GET", "/notification-settings")).json().settings.enabled,
    true,
  );
  assert.equal(
    (
      await call(
        "PUT",
        "/notification-settings",
        { settings, expectedVersion: 1, userId: ownerId },
        member,
      )
    ).statusCode,
    400,
  );
});
test("assignment opt-out suppresses only that category and mention fallback respects comment preferences", async () => {
  const settings = defaultNotificationSettings();
  settings.categories.assignment = false;
  settings.categories.mention = false;
  assert.equal((await put(settings)).statusCode, 200);
  const target = await make("task", { assigneeId: memberId, status: "todo" });
  const notifications = async () =>
    (
      await call(
        "GET",
        `/workspaces/${workspaceId}/resources`,
        undefined,
        member,
      )
    )
      .json()
      .resources.filter(
        (item: Resource) =>
          item.kind === "notification" && item.data.targetId === target.id,
      );
  assert.equal((await notifications()).length, 0);
  await make("comment", {
    targetId: target.id,
    description: "@notification-member@example.test please review",
  });
  assert.equal((await notifications()).length, 1);
  assert.equal((await notifications())[0].title, "Nuevo comentario");
  settings.categories.comment = false;
  await put(settings);
  await make("comment", {
    targetId: target.id,
    description: "@notification-member@example.test still muted",
  });
  assert.equal((await notifications()).length, 1);
});
const frozen = new Date("2026-11-02T23:00:00Z"),
  delivery = new Date("2026-11-03T08:00:00Z");
async function queue(
  target: Resource,
  category: "assignment" | "summary" = "assignment",
) {
  const settings = defaultNotificationSettings();
  settings.quiet.enabled = true;
  await put(settings);
  const id = randomUUID();
  await db.transaction(async (tx) =>
    assert.equal(
      await scheduleNotification(
        tx,
        {
          id,
          workspace_id: workspaceId,
          title: "Deferred notification",
          data: {
            assigneeId: memberId,
            targetId: target.id,
            description: target.title,
            read: false,
          },
          created_by: ownerId,
        },
        category,
        frozen,
      ),
      "queued",
    ),
  );
  return id;
}
test("quiet deliveries survive engine recreation, stay absent before delivery and are persisted exactly once", async () => {
  const target = await make("task", { status: "todo" }),
    id = await queue(target);
  assert.equal(
    (await call("GET", "/notification-settings", undefined, member)).json()
      .pending,
    1,
  );
  assert.equal(
    (await call("GET", `/resources/${id}/location`, undefined, member))
      .statusCode,
    404,
  );
  assert.equal(
    (await deliverNotifications(db, new Date("2026-11-03T07:59:59Z"))).size,
    0,
  );
  await new AutomationEngine(db).tick(delivery, workspaceId);
  await deliverNotifications(db, delivery);
  assert.equal(
    (await db.query("SELECT id FROM resources WHERE id=$1", [id])).rows.length,
    1,
  );
  assert.equal(
    (await db.query("SELECT id FROM notification_queue WHERE id=$1", [id])).rows
      .length,
    0,
  );
});
test("deferred deliveries recheck target privacy, deleted targets, membership and current category opt-outs", async () => {
  for (const change of ["privacy", "delete", "preferences", "membership"]) {
    const project = await make("project", {});
    const target = await make("task", {
      status: "todo",
      projectId: project.id,
    });
    const id = await queue(target);
    if (change === "privacy")
      await make(
        "project",
        { private: true, members: [] },
        project.title,
        project,
      );
    if (change === "delete")
      await db.query("UPDATE resources SET deleted_at=now() WHERE id=$1", [
        target.id,
      ]);
    if (change === "preferences") {
      const settings = defaultNotificationSettings();
      settings.categories.assignment = false;
      await put(settings);
    }
    if (change === "membership")
      await db.query(
        "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, memberId],
      );
    await deliverNotifications(db, new Date("2027-01-01T12:00:00Z"));
    assert.equal(
      (await db.query("SELECT id FROM resources WHERE id=$1", [id])).rows
        .length,
      0,
      change,
    );
    assert.equal(
      (await db.query("SELECT id FROM notification_queue WHERE id=$1", [id]))
        .rows.length,
      0,
      change,
    );
    if (change === "membership")
      await db.query(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
        [workspaceId, memberId],
      );
  }
});
test("preference changes wake pending rows and postponed quiet schedules are recalculated without duplicates", async () => {
  const target = await make("task", {}),
    id = await queue(target);
  const settings = defaultNotificationSettings();
  settings.quiet.enabled = true;
  settings.quiet.end = "10:00";
  await put(settings);
  await db.query("UPDATE notification_queue SET deliver_at=$1 WHERE id=$2", [
    frozen.toISOString(),
    id,
  ]);
  await deliverNotifications(db, delivery);
  const row = (
    await db.query("SELECT deliver_at FROM notification_queue WHERE id=$1", [
      id,
    ])
  ).rows[0];
  assert.equal(
    new Date(row.deliver_at).toISOString(),
    "2026-11-03T10:00:00.000Z",
  );
  settings.quiet.enabled = false;
  await put(settings);
  await deliverNotifications(db, new Date("2027-01-01T12:00:00Z"));
  assert.equal(
    (await db.query("SELECT id FROM resources WHERE id=$1", [id])).rows.length,
    1,
  );
});
