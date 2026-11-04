import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automations";
import { nextOccurrence, validDay, zonedClock } from "../shared/automation";
import type { Resource } from "../shared/model";

let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  ownerId: string,
  ownerCookie: string,
  memberId: string,
  memberCookie: string,
  viewerId: string;
const now = new Date("2027-01-31T12:00:00Z");
const headers = { "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1", origin: "http://test.local" };
const request = (
  method: any,
  url: string,
  payload?: any,
  cookie = ownerCookie,
) => api.app.inject({ method, url, payload, headers: { ...headers, cookie } });
const mutate = (
  kind: string,
  title: string,
  data: any = {},
  id: string = randomUUID(),
  version = 0,
  cookie = ownerCookie,
  operationId: string = randomUUID(),
) =>
  request(
    "POST",
    `/api/workspaces/${workspaceId}/mutate`,
    { id, kind, title, data, expectedVersion: version, operationId },
    cookie,
  );
async function make(
  kind: string,
  title: string,
  data: any = {},
  cookie = ownerCookie,
) {
  const response = await mutate(
    kind,
    title,
    data,
    undefined,
    undefined,
    cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
async function edit(resource: Resource, data: any, cookie = ownerCookie) {
  const response = await mutate(
    resource.kind,
    resource.title,
    { ...resource.data, ...data },
    resource.id,
    resource.version,
    cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
async function current(id: string) {
  return (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id]))
    .rows[0];
}
async function invite(email: string, role: string) {
  const invitation = await request(
    "POST",
    `/api/workspaces/${workspaceId}/invitations`,
    { email, role },
  );
  assert.equal(invitation.statusCode, 200, invitation.body);
  const token = new URL(invitation.json().url).searchParams.get("invitation");
  const response = await request("POST", "/api/invitations/accept", {
    email,
    role,
    name: email,
    password: "invited-password-long",
    token,
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me", undefined, cookie)).json();
  return { id: me.user.id, cookie };
}
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, {
    origin: "http://test.local",
    setupToken: "test-setup-token",
    encryptionKey: "ab".repeat(32),
    trustedProxy: "127.0.0.1",
  });
  const setup = await request(
    "POST",
    "/api/setup",
    {
      email: "automation-owner@example.test",
      password: "test-password-long-enough",
      name: "Automation owner",
      workspaceName: "Automation tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
  const member = await invite("automation-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerId = (await invite("automation-viewer@example.test", "viewer")).id;
});
afterEach(async () => {
  await db.query(
    "UPDATE resources SET data=jsonb_set(data,'{enabled}','false') WHERE kind='automation'",
  );
  await db.query(
    "UPDATE automation_runs SET status='cancelled' WHERE status='queued'",
  );
  await db.query(
    "UPDATE memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, memberId],
  );
});
after(async () => {
  await api.app.close();
  await db.close();
});

test("monthly recurrence preserves the anchor day and scheduled clocks honor daylight saving", () => {
  assert.equal(validDay("2027-02-31"), false);
  assert.equal(validDay("2028-02-29"), true);
  assert.equal(
    nextOccurrence("2027-01-31", "monthly", "2027-01-31", 31),
    "2027-02-28",
  );
  assert.equal(
    nextOccurrence("2027-02-28", "monthly", "2027-02-28", 31),
    "2027-03-31",
  );
  assert.equal(
    nextOccurrence("2026-01-01", "daily", "2027-01-31"),
    "2027-02-01",
  );
  assert.deepEqual(
    zonedClock(new Date("2027-03-28T07:00:00Z"), "Europe/Madrid"),
    { day: "2027-03-28", time: "09:00" },
  );
});
test("event effects are durable, idempotent, versioned and do not recursively chain rules", async () => {
  const fieldId = randomUUID();
  const project = await make("project", "Event project", {
    fieldDefinitions: [
      {
        id: fieldId,
        name: "Estimate",
        type: "number",
        required: true,
        defaultValue: 0,
      },
    ],
  });
  await make("automation", "Assign new work", {
    projectId: project.id,
    enabled: true,
    trigger: "task_created",
    action: "assign",
    actionValue: memberId,
    matchLabel: "triage",
  });
  await make("automation", "Notify on manual edits", {
    projectId: project.id,
    enabled: true,
    trigger: "task_updated",
    action: "notify",
    actionValue: viewerId,
  });
  const id = randomUUID(),
    operationId = randomUUID(),
    data = { projectId: project.id, status: "todo", labels: ["triage"] };
  const response = await mutate(
    "task",
    "New issue",
    data,
    id,
    0,
    ownerCookie,
    operationId,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    (await mutate("task", "New issue", data, id, 0, ownerCookie, operationId))
      .statusCode,
    200,
  );
  await api.automations.tick(now, workspaceId);
  await api.automations.tick(now, workspaceId);
  const task = await current(id);
  assert.equal(task.data.assigneeId, memberId);
  assert.equal(task.data.customFields[fieldId], 0);
  assert.equal(task.data.fieldSnapshots[0].name, "Estimate");
  assert.equal(task.version, 2);
  assert.equal(
    (await db.query("SELECT * FROM automation_runs WHERE target_id=$1", [id]))
      .rows.length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT * FROM resource_versions WHERE resource_id=$1", [
        id,
      ])
    ).rows.length,
    2,
  );
  await edit(task, { priority: "high" });
  await api.automations.tick(now, workspaceId);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM resources WHERE kind='notification' AND data->>'targetId'=$1 AND data->>'assigneeId'=$2",
        [id, viewerId],
      )
    ).rows.length,
    1,
  );
});
test("enabled rules validate actions and members cannot edit another author or create global rules", async () => {
  const project = await make("project", "Validation project");
  assert.equal(
    (
      await mutate("automation", "Invalid state", {
        projectId: project.id,
        enabled: true,
        trigger: "task_created",
        action: "set_status",
        actionValue: "invalid",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await mutate(
        "automation",
        "Global member rule",
        {
          enabled: true,
          trigger: "task_created",
          action: "notify",
          actionValue: memberId,
        },
        undefined,
        0,
        memberCookie,
      )
    ).statusCode,
    403,
  );
  const rule = await make("automation", "Owner rule", {
    projectId: project.id,
    enabled: true,
    trigger: "task_created",
    action: "set_status",
    actionValue: "review",
  });
  assert.equal(
    (
      await mutate(
        "automation",
        rule.title,
        { ...rule.data, enabled: false },
        rule.id,
        rule.version,
        memberCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await mutate("task", "Invalid recurrence", { recurrence: "weekly" }))
      .statusCode,
    400,
  );
  assert.equal(
    (await mutate("task", "Invalid day", { dueDate: "2027-02-31" })).statusCode,
    400,
  );
});
test("current author permissions are rechecked and an authorized retry remains single-effect", async () => {
  const project = await make("project", "Permission project");
  const rule = await make(
    "automation",
    "Member rule",
    {
      projectId: project.id,
      enabled: true,
      trigger: "task_created",
      action: "set_status",
      actionValue: "review",
    },
    memberCookie,
  );
  const task = await make("task", "Permission issue", {
    projectId: project.id,
    status: "todo",
  });
  await db.query(
    "UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, memberId],
  );
  await api.automations.tick(now, workspaceId);
  assert.equal((await current(task.id)).data.status, "todo");
  let run = (
    await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [rule.id])
  ).rows[0];
  assert.equal(run.status, "cancelled");
  assert.equal(run.result.reason, "permissions_changed");
  assert.equal(
    (
      await request(
        "POST",
        `/api/workspaces/${workspaceId}/automations/runs/${run.id}/retry`,
        {},
        memberCookie,
      )
    ).statusCode,
    403,
  );
  await db.query(
    "UPDATE memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, memberId],
  );
  assert.equal(
    (
      await request(
        "POST",
        `/api/workspaces/${workspaceId}/automations/runs/${run.id}/retry`,
        {},
        memberCookie,
      )
    ).statusCode,
    200,
  );
  await api.automations.tick(now, workspaceId);
  await api.automations.tick(now, workspaceId);
  assert.equal((await current(task.id)).version, 2);
  run = (await db.query("SELECT * FROM automation_runs WHERE id=$1", [run.id]))
    .rows[0];
  assert.equal(run.status, "succeeded");
  assert.equal(run.attempts, 2);
});
test("private targets and revised rules cannot be executed or disclosed through run history", async () => {
  const project = await make("project", "Hidden project", {
    private: true,
    members: [],
  });
  const publicProject = await make("project", "Public rule project");
  const rule = await make(
    "automation",
    "Rule moved after enqueue",
    {
      projectId: publicProject.id,
      enabled: true,
      trigger: "task_created",
      action: "set_status",
      actionValue: "review",
    },
    memberCookie,
  );
  const task = await make("task", "Changed rule issue", {
    projectId: publicProject.id,
    status: "todo",
  });
  await edit(rule, { actionValue: "in_progress" }, memberCookie);
  await api.automations.tick(now, workspaceId);
  assert.equal((await current(task.id)).data.status, "todo");
  assert.equal(
    (
      await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [
        rule.id,
      ])
    ).rows[0].result.reason,
    "rule_changed",
  );
  const global = await make("automation", "Private visibility test", {
    enabled: true,
    trigger: "task_created",
    action: "set_status",
    actionValue: "review",
  });
  const secret = await make("task", "Private issue", {
    projectId: project.id,
    status: "todo",
  });
  await api.automations.tick(now, workspaceId);
  const history = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/automations/runs`,
      undefined,
      memberCookie,
    )
  ).json();
  assert.ok(!history.runs.some((run: any) => run.target_id === secret.id));
  assert.ok(
    (
      await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [
        global.id,
      ])
    ).rows.length,
  );
});
test("overdue reminders are once per due date and daily summaries use the rule time zone", async () => {
  const project = await make("project", "Scheduled project");
  const overdue = await make("automation", "Due reminder", {
    projectId: project.id,
    enabled: true,
    trigger: "task_overdue",
    action: "notify",
    actionValue: viewerId,
    timeZone: "Europe/Madrid",
    timeOfDay: "13:00",
    matchLabel: "watch",
  });
  const summary = await make("automation", "Daily summary", {
    projectId: project.id,
    enabled: true,
    trigger: "daily_summary",
    action: "notify",
    actionValue: ownerId,
    timeZone: "Europe/Madrid",
    timeOfDay: "13:00",
  });
  await make("task", "Due issue", {
    projectId: project.id,
    status: "todo",
    dueDate: "2027-01-31",
    labels: ["watch"],
  });
  await make("task", "Finished issue", {
    projectId: project.id,
    status: "done",
    dueDate: "2027-01-30",
  });
  await api.automations.tick(new Date("2027-01-31T11:59:00Z"), workspaceId);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM automation_runs WHERE rule_id=ANY($1::uuid[])",
        [[overdue.id, summary.id]],
      )
    ).rows.length,
    0,
  );
  await api.automations.tick(now, workspaceId);
  await api.automations.tick(now, workspaceId);
  const runs = (
    await db.query(
      "SELECT * FROM automation_runs WHERE rule_id=ANY($1::uuid[])",
      [[overdue.id, summary.id]],
    )
  ).rows;
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === "succeeded"));
  await api.automations.tick(new Date("2027-02-01T12:00:00Z"), workspaceId);
  assert.equal(
    (
      await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [
        overdue.id,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [
        summary.id,
      ])
    ).rows.length,
    2,
  );
});
test("recurrence creates one future task, resets checklist and sprint, keeps monthly anchor and stops at series end", async () => {
  const fieldId = randomUUID();
  const project = await make("project", "Recurring project", {
      fieldDefinitions: [
        {
          id: fieldId,
          name: "Approved",
          type: "boolean",
          required: true,
          defaultValue: false,
        },
      ],
    }),
    sprint = await make("sprint", "Old sprint", { status: "active" });
  let task = await make("task", "Monthly review", {
    projectId: project.id,
    sprintId: sprint.id,
    status: "todo",
    dueDate: "2027-01-31",
    startDate: "2027-01-30",
    recurrence: "monthly",
    recurrenceEndDate: "2027-03-31",
    timeZone: "UTC",
    checklist: [{ id: "one", text: "Review", done: true }],
  });
  task = await edit(task, { status: "done" });
  await api.automations.tick(now, workspaceId);
  const run = (
    await db.query("SELECT * FROM automation_runs WHERE target_id=$1", [
      task.id,
    ])
  ).rows[0];
  let next = await current(run.result.resourceId);
  assert.equal(next.data.dueDate, "2027-02-28");
  assert.equal(next.data.recurrenceDay, 31);
  assert.equal(next.data.startDate, "2027-02-27");
  assert.equal(next.data.sprintId, null);
  assert.equal(next.data.checklist[0].done, false);
  assert.equal(next.data.customFields[fieldId], false);
  assert.equal(next.data.fieldSnapshots[0].name, "Approved");
  task = await edit(await edit(task, { status: "todo" }), { status: "done" });
  await api.automations.tick(now, workspaceId);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM automation_runs WHERE target_id=$1 AND trigger='recurrence'",
        [task.id],
      )
    ).rows.length,
    1,
  );
  next = await edit(next, { status: "done" });
  await api.automations.tick(new Date("2027-02-28T12:00:00Z"), workspaceId);
  const nextRun = (
    await db.query("SELECT * FROM automation_runs WHERE target_id=$1", [
      next.id,
    ])
  ).rows[0];
  const march = await current(nextRun.result.resourceId);
  assert.equal(march.data.dueDate, "2027-03-31");
  await edit(march, { status: "done" });
  await api.automations.tick(new Date("2027-03-31T12:00:00Z"), workspaceId);
  assert.equal(
    (
      await db.query("SELECT * FROM automation_runs WHERE target_id=$1", [
        march.id,
      ])
    ).rows[0].result.seriesEnded,
    true,
  );
});
test("partial execution failure rolls back effects and retries atomically without duplicate output", async () => {
  const project = await make("project", "Retry project");
  const rule = await make("automation", "Retry notification", {
    projectId: project.id,
    enabled: true,
    trigger: "task_created",
    action: "notify",
    actionValue: viewerId,
  });
  const task = await make("task", "Retry issue", {
    projectId: project.id,
    status: "todo",
  });
  let fail = true;
  const failing: Database = {
    ...db,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          query: async (sql, params) => {
            if (fail && sql.startsWith("INSERT INTO activity")) {
              fail = false;
              throw new Error("Injected interrupted write");
            }
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const engine = new AutomationEngine(failing);
  await engine.tick(now, workspaceId);
  let run = (
    await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [rule.id])
  ).rows[0];
  assert.equal(run.status, "queued");
  assert.equal(run.attempts, 1);
  const notifications = () =>
    db.query("SELECT * FROM resources WHERE kind='notification' AND title=$1", [
      rule.title,
    ]);
  assert.equal((await notifications()).rows.length, 0);
  await engine.tick(new Date(now.getTime() + 61000), workspaceId);
  await engine.tick(new Date(now.getTime() + 62000), workspaceId);
  run = (
    await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [rule.id])
  ).rows[0];
  assert.equal(run.status, "succeeded");
  assert.equal(run.attempts, 2);
  assert.equal((await notifications()).rows.length, 1);
  assert.equal(run.target_id, task.id);
  const history = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/automations/runs/${run.id}/attempts`,
    )
  ).json();
  assert.deepEqual(
    history.attempts.map((attempt: any) => attempt.status),
    ["succeeded", "failed"],
  );
  assert.deepEqual(
    history.attempts.map((attempt: any) => attempt.attempt),
    [2, 1],
  );
});
test("independent workers claim one job once and preserve one durable effect", async () => {
  const project = await make("project", "Concurrent workers");
  const rule = await make("automation", "Concurrent notification", {
    projectId: project.id,
    enabled: true,
    trigger: "task_created",
    action: "notify",
    actionValue: viewerId,
  });
  await make("task", "Concurrent worker target", {
    projectId: project.id,
    status: "todo",
  });
  await Promise.all([
    new AutomationEngine(db).tick(now, workspaceId),
    new AutomationEngine(db).tick(now, workspaceId),
  ]);
  const run = (
    await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [rule.id])
  ).rows[0];
  assert.equal(run.status, "succeeded");
  assert.equal(run.attempts, 1);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM resources WHERE kind='notification' AND title=$1",
        [rule.title],
      )
    ).rows.length,
    1,
  );
});
test("only the configured proxy can supply client addresses to login rate limits", async () => {
  const login = async (remoteAddress: string, forwarded: string) =>
    api.app.inject({
      method: "POST",
      url: "/api/login",
      remoteAddress,
      headers: { ...headers, "x-forwarded-for": forwarded },
      payload: {
        email: "absent@example.test",
        password: "test-password-long-enough",
      },
    });
  for (let attempt = 0; attempt < 8; attempt++)
    assert.equal((await login("127.0.0.1", "203.0.113.10")).statusCode, 401);
  assert.equal((await login("127.0.0.1", "203.0.113.10")).statusCode, 429);
  assert.equal((await login("127.0.0.1", "203.0.113.11")).statusCode, 401);
  for (let attempt = 0; attempt < 8; attempt++)
    assert.equal(
      (await login("198.51.100.40", `203.0.113.${20 + attempt}`)).statusCode,
      401,
    );
  assert.equal((await login("198.51.100.40", "203.0.113.99")).statusCode, 429);
});
test("three automatic failures stop retrying and a manual retry preserves every previous attempt", async () => {
  const project = await make("project", "Exhausted retry project");
  const rule = await make("automation", "Exhausted retry notification", {
    projectId: project.id,
    enabled: true,
    trigger: "task_created",
    action: "notify",
    actionValue: viewerId,
  });
  await make("task", "Retry history target", {
    projectId: project.id,
    status: "todo",
  });
  let fail = true;
  const failing: Database = {
    ...db,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          query: async (sql, params) => {
            if (fail && sql.startsWith("INSERT INTO activity"))
              throw new Error("Injected persistent failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const engine = new AutomationEngine(failing);
  for (const seconds of [0, 61, 182, 1000])
    await engine.tick(new Date(now.getTime() + seconds * 1000), workspaceId);
  let run = (
    await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [rule.id])
  ).rows[0];
  assert.equal(run.status, "failed");
  assert.equal(run.attempts, 3);
  assert.equal(
    (
      await request(
        "POST",
        `/api/workspaces/${workspaceId}/automations/runs/${run.id}/retry`,
        {},
      )
    ).statusCode,
    200,
  );
  fail = false;
  await engine.tick(new Date(now.getTime() + 1001000), workspaceId);
  run = (await db.query("SELECT * FROM automation_runs WHERE id=$1", [run.id]))
    .rows[0];
  assert.equal(run.status, "succeeded");
  assert.equal(run.attempts, 4);
  const history = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/automations/runs/${run.id}/attempts`,
    )
  ).json();
  assert.deepEqual(
    history.attempts.map((attempt: any) => attempt.status),
    ["succeeded", "failed", "failed", "failed"],
  );
  assert.equal(
    (
      await db.query(
        "SELECT * FROM resources WHERE kind='notification' AND title=$1",
        [rule.title],
      )
    ).rows.length,
    1,
  );
});
