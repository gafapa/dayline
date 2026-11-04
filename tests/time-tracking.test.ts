import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import {
  validateTimeLog,
  timeEntrySummary,
  filterTimeEntries,
  retainTimeLogContexts,
  formatLogDuration,
} from "../shared/time-tracking";
import type { Resource } from "../shared/model";

const manual = {
  date: "2026-11-03",
  timeZone: "UTC",
  mode: "manual",
  status: "recorded",
  seconds: 3600,
} as const;
test("manual durations are positive integer seconds and clocks measure elapsed DST time", () => {
  assert.equal(validateTimeLog(manual).seconds, 3600);
  assert.throws(() => validateTimeLog({ ...manual, date: "2026-02-30" }));
  assert.throws(() => validateTimeLog({ ...manual, seconds: 0 }));
  assert.throws(() => validateTimeLog({ ...manual, seconds: 0.5 }));
  const clock = {
    ...manual,
    mode: "timer",
    startedAt: "2026-10-25T00:30:00Z",
    stoppedAt: "2026-10-25T02:30:00Z",
    seconds: 7200,
  };
  assert.equal(
    validateTimeLog(clock, new Date("2026-11-03T12:00:00Z")).seconds,
    7200,
  );
  assert.throws(() => validateTimeLog({ ...clock, seconds: 3600 }));
  assert.throws(() =>
    validateTimeLog({ ...clock, stoppedAt: "2026-11-03T02:30:00Z" }),
  );
  assert.equal(formatLogDuration(7201), "2:00:01");
});
let db: Database,
  app: Awaited<ReturnType<typeof createApp>>,
  ws: string,
  owner: string,
  member: string,
  viewer: string,
  ownerId: string,
  memberId: string;
const headers = {
  origin: "http://time.test",
  "x-kelvin-client": "web",
  "x-kelvin-document-schema": "1",
};
const request = (method: any, path: string, payload?: any, cookie = owner) =>
  app.app.inject({
    method,
    url: path.startsWith("/api") ? path : `/api/workspaces/${ws}${path}`,
    payload,
    headers: { ...headers, cookie },
  });
const mutation = (
  kind: string,
  data: any = {},
  id: string = randomUUID(),
  version = 0,
) => ({
  operationId: randomUUID(),
  id,
  kind,
  title: "Time test",
  data,
  expectedVersion: version,
});
async function make(kind: string, data: any = {}, cookie = owner) {
  const input = mutation(kind, data),
    response = await request("POST", "/mutate", input, cookie);
  assert.equal(response.statusCode, 200, response.body);
  return { resource: response.json().resource as Resource, input };
}
async function edit(resource: Resource, patch: any, cookie = owner) {
  return request(
    "POST",
    "/mutate",
    mutation(
      resource.kind,
      { ...resource.data, ...patch },
      resource.id,
      resource.version,
    ),
    cookie,
  );
}
async function read(cookie = owner) {
  return (await request("GET", "/resources", undefined, cookie)).json()
    .resources as Resource[];
}
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  app = await createApp(db, {
    origin: "http://time.test",
    setupToken: "time-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await request(
    "POST",
    "/api/setup",
    {
      email: "time-owner@example.test",
      name: "Time owner",
      password: "time-password-long",
      workspaceName: "Time tests",
      setupToken: "time-setup",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  owner = String(setup.headers["set-cookie"]).split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  ws = me.workspaces[0].id;
  ownerId = me.user.id;
  for (const role of ["member", "viewer"]) {
    const email = `time-${role}@example.test`,
      invitation = await request("POST", "/invitations", { email, role });
    assert.equal(invitation.statusCode, 200, invitation.body);
    const accepted = await request(
      "POST",
      "/api/invitations/accept",
      {
        email,
        name: role,
        password: "time-password-long",
        token: new URL(invitation.json().url).searchParams.get("invitation"),
      },
      "",
    );
    assert.equal(accepted.statusCode, 200, accepted.body);
    const cookie = String(accepted.headers["set-cookie"]).split(";")[0];
    if (role === "member") {
      member = cookie;
      memberId = (await request("GET", "/api/me", undefined, cookie)).json()
        .user.id;
    } else viewer = cookie;
  }
});
after(async () => {
  await app.app.close();
  await db.close();
});
test("private time entries stay personal, shared entries are readable but editable only by their author", async () => {
  const a = await make(
    "time_entry",
    { timeLog: manual, ownerId: memberId },
    member,
  );
  assert.equal(
    (await read()).some((r) => r.id === a.resource.id),
    false,
  );
  const b = await make("time_entry", { timeLog: manual }, member);
  assert.equal(
    (await read(viewer)).some((r) => r.id === b.resource.id),
    true,
  );
  assert.equal(
    (await edit(b.resource, { description: "Admin rewrite" })).statusCode,
    403,
  );
  assert.equal(
    (await edit(b.resource, { ownerId: memberId }, member)).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/mutate",
        mutation("time_entry", { timeLog: manual }),
        viewer,
      )
    ).statusCode,
    403,
  );
});
test("server normalizes derived minutes, rejects forged context/foreign fields and validates task attribution", async () => {
  const project = (await make("project")).resource,
    task = (await make("task", { projectId: project.id })).resource;
  const log = (
    await make("time_entry", {
      timeLog: manual,
      minutes: 999,
      targetId: task.id,
      projectId: project.id,
      timeLogContexts: [[]],
    })
  ).resource;
  assert.equal(log.data.minutes, 60);
  assert.equal(log.data.timeLogContexts[0].length, 2);
  const repeated = await edit(log, { description: "Same permission context" });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().resource.data.timeLogContexts.length, 1);

  assert.equal(
    (await edit(repeated.json().resource, { timeLogContexts: [[]] }))
      .statusCode,
    400,
  );
  assert.equal(
    (await request("POST", "/mutate", mutation("task", { timeLog: manual })))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/mutate",
        mutation("time_entry", { timeLog: manual, assigneeId: ownerId }),
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/mutate",
        mutation("time_entry", {
          timeLog: manual,
          targetId: project.id,
          projectId: project.id,
        }),
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/mutate",
        mutation("time_entry", { timeLog: manual, targetId: task.id }),
      )
    ).statusCode,
    400,
  );
});
test("timer completion is idempotent, retains its start and rejects stale updates and reopening", async () => {
  const start = new Date(Date.now() - 120000).toISOString(),
    end = new Date(Date.parse(start) + 60000).toISOString();
  const timer = (
    await make("time_entry", {
      ownerId: ownerId,
      timeLog: {
        ...manual,
        mode: "timer",
        status: "running",
        seconds: 0,
        startedAt: start,
      },
    })
  ).resource;
  const input = mutation(
    "time_entry",
    {
      ...timer.data,
      timeLog: {
        ...timer.data.timeLog,
        status: "recorded",
        seconds: 60,
        stoppedAt: end,
      },
    },
    timer.id,
    timer.version,
  );
  const saved = await request("POST", "/mutate", input);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    (await request("POST", "/mutate", input)).json().resource.version,
    2,
  );
  assert.equal((await edit(timer, { description: "Stale" })).statusCode, 409);
  const resource = saved.json().resource;
  assert.equal(
    (
      await edit(resource, {
        timeLog: {
          ...resource.data.timeLog,
          startedAt: new Date().toISOString(),
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await edit(resource, {
        timeLog: {
          ...resource.data.timeLog,
          status: "running",
          seconds: 0,
          stoppedAt: undefined,
        },
      })
    ).statusCode,
    400,
  );
});
test("privacy at every edit remains enforced after a project becomes public again, including versions and retry", async () => {
  let project = (await make("project")).resource;
  const task = (await make("task", { projectId: project.id })).resource;
  let entry = (
    await make(
      "time_entry",
      { timeLog: manual, projectId: project.id, targetId: task.id },
      member,
    )
  ).resource;
  project = (await edit(project, { private: true, members: [memberId] })).json()
    .resource;
  const input = mutation(
    "time_entry",
    { ...entry.data, description: "Private interval details" },
    entry.id,
    entry.version,
  );
  const changed = await request("POST", "/mutate", input, member);
  assert.equal(changed.statusCode, 200, changed.body);
  entry = changed.json().resource;
  assert.equal(entry.data.timeLogContexts.length, 2);
  project = (await edit(project, { private: false })).json().resource;
  assert.equal(
    (await read(viewer)).some((r) => r.id === entry.id),
    false,
  );
  assert.equal(
    (await request("GET", `/resources/${entry.id}/versions`, undefined, viewer))
      .statusCode,
    404,
  );
  project = (await edit(project, { private: true, members: [] })).json()
    .resource;
  assert.equal(
    (await request("POST", "/mutate", input, member)).statusCode,
    403,
  );
  assert.equal(
    (await read(member)).some((r) => r.id === entry.id),
    false,
  );
});
test("totals exclude running/deleted/archived work, use descendant projects and retain integer seconds", () => {
  const record = (
    kind: Resource["kind"],
    data: any = {},
    id = randomUUID(),
  ): Resource => ({
    id,
    kind,
    data,
    title: kind,
    workspace_id: ws,
    created_by: ownerId,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
    version: 1,
    deleted_at: null,
  });
  const p = record("project"),
    child = record("project", { parentId: p.id }),
    task = record("task", { projectId: child.id });
  const a = record("time_entry", {
      timeLog: { ...manual, seconds: 61 },
      projectId: child.id,
      targetId: task.id,
    }),
    b = record("time_entry", {
      timeLog: {
        ...manual,
        mode: "timer",
        status: "running",
        seconds: 0,
        startedAt: "2026-11-03T00:00:00Z",
      },
      projectId: p.id,
    });
  const all = [p, child, task, a, b],
    filter = {
      from: "2026-11-01",
      to: "2026-11-30",
      projectId: p.id,
      authorId: "",
      includeDescendants: true,
      includeArchived: false,
    };
  const total = timeEntrySummary(filterTimeEntries(all, filter));
  assert.equal(total.seconds, 61);
  assert.equal(total.running, 1);
  assert.equal(total.recorded, 1);
  assert.equal(
    filterTimeEntries(all, { ...filter, includeDescendants: false }).length,
    1,
  );
  task.deleted_at = new Date().toISOString();
  assert.equal(timeEntrySummary(filterTimeEntries(all, filter)).seconds, 0);
  task.deleted_at = null;
  child.data.archived = true;
  assert.equal(timeEntrySummary(filterTimeEntries(all, filter)).seconds, 0);
  assert.equal(
    timeEntrySummary(
      filterTimeEntries(all, { ...filter, includeArchived: true }),
    ).seconds,
    61,
  );
  assert.throws(() =>
    filterTimeEntries(all, { ...filter, from: "2026-02-30" }),
  );
  const contexts = retainTimeLogContexts(a, all);
  assert.equal(retainTimeLogContexts(a, all, contexts).length, 1);
});

test("permission contexts refuse unsupported ancestor policies and survive jsonb key order", () => {
  const record = (
    kind: Resource["kind"],
    data: any = {},
    id: string = randomUUID(),
  ): Resource => ({
    id,
    kind,
    data,
    title: kind,
    workspace_id: ws,
    created_by: ownerId,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
    version: 1,
    deleted_at: null,
  });
  const project = record("project"),
    task = record("task", { projectId: project.id }),
    entry = record("time_entry", {
      projectId: project.id,
      targetId: task.id,
      timeLog: manual,
    });
  const contexts = retainTimeLogContexts(entry, [project, task, entry]);
  const reordered = contexts.map((context) =>
    context.map(
      (scope) =>
        Object.fromEntries(Object.entries(scope).reverse()) as typeof scope,
    ),
  );
  assert.equal(
    retainTimeLogContexts(entry, [project, task, entry], reordered).length,
    1,
  );
  const dashboard = record("dashboard", {
    dashboardConfig: { projectIds: [] },
  });
  task.data.parentId = dashboard.id;
  assert.throws(
    () => retainTimeLogContexts(entry, [project, task, entry, dashboard]),
    /permisos/,
  );
  task.data.parentId = task.id;
  assert.throws(
    () => retainTimeLogContexts(entry, [project, task, entry]),
    /ciclo/,
  );
});
