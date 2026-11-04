import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import {
  currentAnalytics,
  defaultDashboard,
  reportRange,
  reportCSV,
  historyReportSchema,
} from "../shared/analytics";
import { historicalAnalytics } from "../server/analytics-history";
import type { Resource } from "../shared/model";
const owner = randomUUID(),
  reader = randomUUID(),
  ws = randomUUID();
const resource = (
  kind: Resource["kind"],
  data: Record<string, any> = {},
  id = randomUUID(),
  version = 1,
): Resource => ({
  id,
  workspace_id: ws,
  kind,
  title: kind + " " + id,
  data,
  version,
  created_by: owner,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  deleted_at: null,
});
const event = (snapshot: Resource, time: string) => ({
  snapshot,
  version: snapshot.version,
  created_at: time,
});
const config = { ...defaultDashboard(), from: "2026-11-01", to: "2026-11-03" };
const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
// Server-side history tests record events "now", so their window must follow the clock.
const liveConfig = { ...config, from: isoDay(-2), to: isoDay(1) };
test("portfolio counts every task once and applies descendant, archive, assignee and label scope", () => {
  const root = resource("project"),
    child = resource("project", { parentId: root.id }),
    archived = resource("project", { archived: true }),
    a = resource("task", {
      projectId: root.id,
      status: "done",
      estimate: 0,
      labels: ["release"],
    }),
    b = resource("task", {
      projectId: child.id,
      status: "todo",
      estimate: 5,
      labels: ["release"],
      dependencies: [randomUUID()],
      dueDate: "2026-11-01",
    }),
    cancelled = resource("task", {
      projectId: child.id,
      status: "cancelled",
      estimate: 8,
    }),
    hidden = resource("task", {
      projectId: archived.id,
      status: "todo",
      estimate: 99,
    });
  const all = [root, child, archived, a, b, cancelled, hidden],
    result = currentAnalytics(
      all,
      { ...config, projectIds: [root.id] },
      new Date("2026-11-03T12:00:00Z"),
    );
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.points, 5);
  assert.equal(result.summary.done, 1);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.summary.overdue, 1);
  assert.equal(
    result.portfolio.reduce((n, p) => n + p.total, 0),
    2,
  );
  assert.equal(
    currentAnalytics(all, {
      ...config,
      projectIds: [root.id],
      includeDescendants: false,
    }).tasks.length,
    1,
  );
  assert.equal(
    currentAnalytics(all, {
      ...config,
      labels: ["release"],
      assigneeIds: ["unassigned"],
    }).tasks.length,
    2,
  );
  assert.equal(
    currentAnalytics(all, { ...config, includeArchived: true }).summary.points,
    104,
  );
});
test("historical permission reconstruction retains microsecond ordering within one millisecond", () => {
  const project = resource("project", { private: true }),
    shared = { ...project, version: 2, data: { private: false } },
    task = resource("task", { projectId: project.id, status: "todo" }),
    done = { ...task, version: 2, data: { ...task.data, status: "done" } };
  const rows = [
    event(project, "2026-11-01T10:00:00.000001Z"),
    event(task, "2026-11-01T10:00:00.000002Z"),
    event(done, "2026-11-01T10:00:00.000003Z"),
    event(shared, "2026-11-01T10:00:00.000004Z"),
  ];
  const result = historicalAnalytics(
    [shared, done],
    [done],
    rows,
    reader,
    "member",
    config,
  );
  assert.equal(result.completionEvents, 0);
  assert.equal(result.medianLeadHours, null);
  assert.equal(JSON.stringify(result).includes(project.id), false);
});
test("moving a project out of a private ancestor does not expose its old delivery history", () => {
  const privateRoot = resource("project", { private: true }),
    child = resource("project", { parentId: privateRoot.id }),
    moved = { ...child, version: 2, data: {} },
    task = resource("task", { projectId: child.id, status: "todo" }),
    privateDone = {
      ...task,
      version: 2,
      data: { ...task.data, status: "done" },
    },
    reopened = { ...task, version: 3 },
    started = {
      ...task,
      version: 4,
      data: { ...task.data, status: "in_progress" },
    },
    done = { ...task, version: 5, data: { ...task.data, status: "done" } };
  const rows = [
    event(privateRoot, "2026-11-01T00:00:00Z"),
    event(child, "2026-11-01T01:00:00Z"),
    event(task, "2026-11-01T02:00:00Z"),
    event(privateDone, "2026-11-01T03:00:00Z"),
    event(moved, "2026-11-02T00:00:00Z"),
    event(reopened, "2026-11-02T01:00:00Z"),
    event(started, "2026-11-02T02:00:00Z"),
    event(done, "2026-11-02T04:00:00Z"),
  ];
  const result = historicalAnalytics(
    [privateRoot, moved, done],
    [done],
    rows,
    reader,
    "member",
    config,
  );
  assert.equal(result.completionEvents, 1);
  assert.equal(result.reopenedEvents, 0);
  assert.equal(result.medianLeadHours, null);
  assert.equal(result.medianCycleHours, 2);
});
test("delivery durations use elapsed hours across daylight saving and sprint rows use scoped closure tasks", () => {
  const project = resource("project"),
    task = resource("task", {
      projectId: project.id,
      status: "in_progress",
      estimate: 3,
    }),
    done = { ...task, version: 2, data: { ...task.data, status: "done" } },
    sprint = resource("sprint", {
      status: "completed",
      closedAt: "2026-10-25T03:00:00Z",
      snapshot: [done],
    });
  const result = historicalAnalytics(
    [project, done, sprint],
    [done],
    [
      event(project, "2026-10-24T00:00:00Z"),
      event(task, "2026-10-25T00:30:00Z"),
      event(done, "2026-10-25T02:30:00Z"),
    ],
    reader,
    "member",
    {
      ...config,
      from: "2026-10-24",
      to: "2026-10-25",
      timeZone: "Europe/Madrid",
    },
  );
  assert.equal(result.medianCycleHours, 2);
  assert.equal(result.completionEvents, 1);
  assert.equal(result.closedSprints[0].completedPoints, 3);
  assert.equal(result.daily[1].completed, 1);
  historyReportSchema.parse(result);
});
test("report ranges reject invalid calendar dates and CSV exports neutralize spreadsheet formula cells", () => {
  assert.throws(() => reportRange({ ...config, from: "2026-02-30" }));
  assert.throws(() => reportRange({ ...config, to: "" }));
  const csv = reportCSV([[" =SUM(1,2)", 'Line\n"quoted"', 0]]);
  assert.ok(csv.includes("' =SUM(1,2)"));
  assert.ok(csv.includes('"Line\n""quoted"""'));
  assert.ok(csv.endsWith("\r\n"));
});
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  ownerCookie: string,
  ownerId: string,
  memberCookie: string,
  viewerCookie: string;
const headers = {
  origin: "http://test.local",
  "x-kelvin-client": "web",
  "x-kelvin-document-schema": "1",
};
const request = (
  method: any,
  path: string,
  payload?: any,
  cookie = ownerCookie,
) =>
  api.app.inject({
    method,
    url: path.startsWith("/api")
      ? path
      : `/api/workspaces/${workspaceId}${path}`,
    payload,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
  });
async function make(kind: string, data: any = {}, cookie = ownerCookie) {
  const body = {
      id: randomUUID(),
      operationId: randomUUID(),
      kind,
      title: "Analytics " + kind,
      data,
      expectedVersion: 0,
    },
    r = await request("POST", "/mutate", body, cookie);
  assert.equal(r.statusCode, 200, r.body);
  return { resource: r.json().resource as Resource, body };
}
const edit = (r: Resource, data: any, cookie = ownerCookie) =>
  request(
    "POST",
    "/mutate",
    {
      id: r.id,
      operationId: randomUUID(),
      kind: r.kind,
      title: r.title,
      data: { ...r.data, ...data },
      expectedVersion: r.version,
    },
    cookie,
  );
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, {
    origin: "http://test.local",
    setupToken: "analytics-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await request("POST", "/api/setup", {
    email: "analytics-owner@example.test",
    password: "analytics-password-long",
    name: "Analytics owner",
    workspaceName: "Analytics tests",
    setupToken: "analytics-setup",
  });
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
  for (const role of ["member", "viewer"]) {
    const email = `analytics-${role}@example.test`,
      invitation = await request("POST", "/invitations", { email, role });
    assert.equal(invitation.statusCode, 200, invitation.body);
    const accepted = await request("POST", "/api/invitations/accept", {
      email,
      name: role,
      password: "analytics-password-long",
      token: new URL(invitation.json().url).searchParams.get("invitation"),
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const cookie = accepted.headers["set-cookie"]!.toString().split(";")[0];
    if (role === "member") memberCookie = cookie;
    else viewerCookie = cookie;
  }
});
after(async () => {
  await api.app.close();
  await db.close();
});
test("saved dashboards enforce authorship, personal ownership, project ACL and idempotent creation", async () => {
  const project = (await make("project")).resource,
    created = await make("dashboard", {
      dashboardConfig: { ...config, projectIds: [project.id] },
    }),
    panel = created.resource;
  assert.equal(
    (await request("POST", "/mutate", created.body)).json().resource.id,
    panel.id,
  );
  assert.equal(
    (await edit(panel, { dashboardConfig: config }, memberCookie)).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/mutate",
        { ...created.body, id: randomUUID(), operationId: randomUUID() },
        viewerCookie,
      )
    ).statusCode,
    403,
  );
  const personal = (
    await make("dashboard", { ownerId: ownerId, dashboardConfig: config })
  ).resource;
  const visible = (
    await request("GET", "/resources", undefined, viewerCookie)
  ).json().resources;
  assert.ok(visible.some((r: Resource) => r.id === panel.id));
  assert.ok(!visible.some((r: Resource) => r.id === personal.id));
  assert.equal((await edit(project, { private: true })).statusCode, 200);
  assert.ok(
    !(await request("GET", "/resources", undefined, memberCookie))
      .json()
      .resources.some((r: Resource) => r.id === panel.id),
  );
  const denied = await request(
    "POST",
    "/analytics",
    { ...config, projectIds: [project.id] },
    memberCookie,
  );
  assert.equal(denied.statusCode, 400);
  assert.ok(!denied.body.includes(project.id));
});
test("dashboard validation rejects stale versions, duplicate widgets, invalid dates and foreign field placement", async () => {
  const panel = (await make("dashboard", { dashboardConfig: config })).resource;
  assert.equal((await edit(panel, { description: "Updated" })).statusCode, 200);
  assert.equal((await edit(panel, { description: "Stale" })).statusCode, 409);
  assert.equal(
    (
      await request("POST", "/analytics", {
        ...config,
        widgets: ["summary", "summary"],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request("POST", "/analytics", {
        ...config,
        timeZone: "Invalid/Zone",
      })
    ).statusCode,
    400,
  );
  const project = (await make("project")).resource;
  assert.equal(
    (await edit(project, { dashboardConfig: config })).statusCode,
    400,
  );
});
test("analytics endpoint computes SQL-backed delivery metrics and returns no historical document content", async () => {
  const project = (await make("project")).resource,
    first = (
      await make("task", { projectId: project.id, status: "todo", estimate: 5 })
    ).resource;
  const started = await edit(first, { status: "in_progress" });
  assert.equal(started.statusCode, 200, started.body);
  const done = await edit(started.json().resource, { status: "done" });
  assert.equal(done.statusCode, 200, done.body);
  for (const [id, version, time] of [
    [project.id, 1, "2026-11-01T09:00:00Z"],
    [first.id, 1, "2026-11-01T10:00:00Z"],
    [first.id, 2, "2026-11-01T11:00:00Z"],
    [first.id, 3, "2026-11-02T11:00:00Z"],
  ] as const)
    await db.query(
      "UPDATE resource_versions SET created_at=$3 WHERE resource_id=$1 AND version=$2",
      [id, version, time],
    );
  const result = await request(
    "POST",
    "/analytics",
    { ...config, projectIds: [project.id] },
    viewerCookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  const body = historyReportSchema.parse(result.json());
  assert.ok(body.available);
  if (body.available) {
    assert.equal(body.completionEvents, 1);
    assert.equal(body.medianLeadHours, 25);
    assert.equal(body.medianCycleHours, 24);
  }
  assert.ok(!result.body.includes(first.id));
});
test("bounded history refuses a partial result when the selected task exceeds the event budget", async () => {
  const project = (await make("project")).resource,
    task = (await make("task", { projectId: project.id, status: "todo" }))
      .resource;
  await db.query(
    "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) SELECT $1,n,jsonb_set($2::jsonb,'{version}',to_jsonb(n)),$3 FROM generate_series(2,5002) n",
    [task.id, JSON.stringify(task), ownerId],
  );
  const result = await request("POST", "/analytics", {
    ...defaultDashboard(),
    projectIds: [project.id],
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().available, false);
  assert.equal(result.json().reason, "history_limit");
  assert.equal(result.json().daily, undefined);
});

test("historical dashboard filters retain their original ancestor privacy after a project moves", async () => {
  const root = (await make("project", { private: true })).resource,
    child = (await make("project", { parentId: root.id })).resource,
    publicProject = (await make("project")).resource;
  const panel = (
    await make("dashboard", {
      dashboardConfig: {
        ...config,
        projectIds: [child.id],
        labels: ["private-filter-sentinel"],
      },
    })
  ).resource;
  assert.equal(
    (
      await edit(panel, {
        dashboardConfig: {
          ...config,
          projectIds: [publicProject.id],
          labels: ["public"],
        },
      })
    ).statusCode,
    200,
  );
  assert.equal((await edit(child, { parentId: null })).statusCode, 200);
  const result = await request(
    "GET",
    `/resources/${panel.id}/versions`,
    undefined,
    memberCookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.body.includes("private-filter-sentinel"), false);
  assert.ok(result.body.includes("public"));
});

test("SQL historical scope keeps private transitions private even when visibility changes within one millisecond", async () => {
  const project = (await make("project", { private: true })).resource,
    task = (await make("task", { projectId: project.id, status: "todo" }))
      .resource;
  assert.equal((await edit(task, { status: "done" })).statusCode, 200);
  assert.equal((await edit(project, { private: false })).statusCode, 200);
  for (const [id, version, time] of [
    [project.id, 1, "2026-11-01T10:00:00.000001Z"],
    [task.id, 1, "2026-11-01T10:00:00.000002Z"],
    [task.id, 2, "2026-11-01T10:00:00.000003Z"],
    [project.id, 2, "2026-11-01T10:00:00.000004Z"],
  ] as const)
    await db.query(
      "UPDATE resource_versions SET created_at=$3 WHERE resource_id=$1 AND version=$2",
      [id, version, time],
    );
  const result = await request(
    "POST",
    "/analytics",
    { ...config, projectIds: [project.id] },
    viewerCookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().completionEvents, 0);
  assert.equal(result.json().medianLeadHours, null);
});

test("unreadable former ancestors do not consume the report history budget or hide later public deliveries", async () => {
  const root = (await make("project", { private: true })).resource,
    child = (await make("project", { parentId: root.id })).resource,
    task = (await make("task", { projectId: child.id, status: "todo" }))
      .resource;
  assert.equal((await edit(task, { status: "done" })).statusCode, 200);
  await db.query(
    "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) SELECT $1,n,jsonb_set($2::jsonb,'{version}',to_jsonb(n)),$3 FROM generate_series(2,10002) n",
    [root.id, JSON.stringify(root), ownerId],
  );
  await db.query("UPDATE resources SET version=10002 WHERE id=$1", [root.id]);
  const preview = await request("POST", "/hierarchy/preview", {
    id: child.id,
    destinationId: null,
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const moved = await request("POST", "/hierarchy/move", {
    id: child.id,
    destinationId: null,
    operationId: randomUUID(),
    fingerprint: preview.json().fingerprint,
  });
  assert.equal(moved.statusCode, 200, moved.body);
  let current = (
    await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [task.id])
  ).rows[0];
  for (const status of ["todo", "in_progress", "done"]) {
    const next = await edit(current, { status });
    assert.equal(next.statusCode, 200, next.body);
    current = next.json().resource;
  }
  const result = await request(
    "POST",
    "/analytics",
    { ...liveConfig, projectIds: [child.id] },
    viewerCookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().available, true);
  assert.equal(result.json().completionEvents, 1);
  assert.equal(result.body.includes(root.id), false);
});

test("a dashboard command replay rechecks its recorded private ancestor after the actor loses that permission", async () => {
  const root = (await make("project", { private: true }, memberCookie))
      .resource,
    child = (await make("project", { parentId: root.id }, memberCookie))
      .resource,
    publicProject = (await make("project")).resource;
  const created = await make("dashboard", {
    dashboardConfig: {
      ...config,
      projectIds: [child.id],
      labels: ["original-command-private-filter"],
    },
  });
  assert.equal(
    (
      await edit(created.resource, {
        dashboardConfig: { ...config, projectIds: [publicProject.id] },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await edit(child, { parentId: null }, memberCookie)).statusCode,
    200,
  );
  const memberId = (
    await request("GET", "/api/me", undefined, memberCookie)
  ).json().user.id;
  assert.equal(
    (await request("PATCH", `/members/${memberId}`, { role: "admin" }))
      .statusCode,
    200,
  );
  try {
    assert.equal(
      (
        await request(
          "PATCH",
          `/members/${ownerId}`,
          { role: "member" },
          memberCookie,
        )
      ).statusCode,
      200,
    );
    const replay = await request("POST", "/mutate", created.body);
    assert.equal(replay.statusCode, 403, replay.body);
    assert.equal(
      replay.body.includes("original-command-private-filter"),
      false,
    );
  } finally {
    await request(
      "PATCH",
      `/members/${ownerId}`,
      { role: "admin" },
      memberCookie,
    );
    await request("PATCH", `/members/${memberId}`, { role: "member" });
  }
});

test("review rework keeps the first cycle start while reopening begins a new measured cycle", () => {
  const project = resource("project"),
    task = resource("task", { projectId: project.id, status: "todo" }),
    states = [
      "todo",
      "in_progress",
      "review",
      "in_progress",
      "done",
      "todo",
      "in_progress",
      "done",
    ],
    hours = [10, 11, 12, 13, 14, 15, 16, 18];
  const rows = states.map((status, index) =>
      event(
        { ...task, version: index + 1, data: { ...task.data, status } },
        `2026-11-01T${hours[index]}:00:00Z`,
      ),
    ),
    latest = rows.at(-1)!.snapshot;
  const result = historicalAnalytics(
    [project, latest],
    [latest],
    [event(project, "2026-11-01T00:00:00Z"), ...rows],
    reader,
    "member",
    config,
  );
  assert.equal(result.completionEvents, 2);
  assert.equal(result.reopenedEvents, 1);
  assert.equal(result.medianCycleHours, 2.5);
  assert.equal(result.medianLeadHours, 6);
});

test("an unchanged subproject cannot retain old read permission when its ancestor becomes private", () => {
  const root = resource("project"),
    child = resource("project", { parentId: root.id }),
    task = resource("task", { projectId: child.id, status: "todo" }),
    started = {
      ...task,
      version: 2,
      data: { ...task.data, status: "in_progress" },
    },
    privateRoot = { ...root, version: 2, data: { private: true } },
    privateDone = {
      ...task,
      version: 3,
      data: { ...task.data, status: "done" },
    },
    sharedRoot = { ...root, version: 3 },
    again = { ...task, version: 4 },
    restarted = { ...started, version: 5 },
    done = { ...privateDone, version: 6 };
  const rows = [
    event(root, "2026-11-01T00:00:00Z"),
    event(child, "2026-11-01T01:00:00Z"),
    event(task, "2026-11-01T02:00:00Z"),
    event(started, "2026-11-01T03:00:00Z"),
    event(privateRoot, "2026-11-01T04:00:00Z"),
    event(privateDone, "2026-11-01T05:00:00Z"),
    event(sharedRoot, "2026-11-01T06:00:00Z"),
    event(again, "2026-11-01T07:00:00Z"),
    event(restarted, "2026-11-01T08:00:00Z"),
    event(done, "2026-11-01T10:00:00Z"),
  ];
  const result = historicalAnalytics(
    [sharedRoot, child, done],
    [done],
    rows,
    reader,
    "member",
    config,
  );
  assert.equal(result.completionEvents, 1);
  assert.equal(result.medianCycleHours, 2);
  assert.equal(result.medianLeadHours, null);
});

test("pending local ancestor deletions hide live descendant work before an offline save reaches the server", () => {
  const root = resource("project"),
    child = resource("project", { parentId: root.id }),
    parent = resource("task", { projectId: child.id, status: "todo" }),
    task = resource("task", {
      projectId: child.id,
      parentId: parent.id,
      status: "todo",
      estimate: 5,
    });
  const deletedRoot = { ...root, deleted_at: "2026-11-03T00:00:00Z" };
  for (const includeArchived of [false, true])
    assert.equal(
      currentAnalytics([deletedRoot, child, parent, task], {
        ...config,
        includeArchived,
      }).summary.total,
      0,
    );
  const result = currentAnalytics(
    [root, child, { ...parent, deleted_at: "2026-11-03T00:00:00Z" }, task],
    config,
  );
  assert.equal(result.summary.total, 0);
  assert.equal(
    result.portfolio.reduce((n, p) => n + p.total, 0),
    0,
  );
});

test("dashboard permission context is bounded before queuing and cannot grow with repeated large membership lists", async () => {
  const { dashboardReferenceScopes } = await import("../shared/analytics");
  const members = Array.from({ length: 300 }, () => randomUUID()),
    projects = Array.from({ length: 50 }, () =>
      resource("project", { members, private: true }),
    );
  assert.throws(
    () =>
      dashboardReferenceScopes(
        { projectIds: projects.map((p) => p.id) },
        projects,
      ),
    /512 KiB/,
  );
  const scopes = dashboardReferenceScopes(
    { projectIds: [projects[0].id] },
    projects,
  );
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].members?.length, 300);
});
test("SQL history preserves the requesting readers original membership in a private project", async () => {
  const viewerId = (
      await request("GET", "/api/me", undefined, viewerCookie)
    ).json().user.id,
    project = (await make("project", { private: true, members: [viewerId] }))
      .resource,
    task = (await make("task", { projectId: project.id, status: "todo" }))
      .resource;
  assert.equal((await edit(task, { status: "done" })).statusCode, 200);
  const result = await request(
    "POST",
    "/analytics",
    { ...liveConfig, projectIds: [project.id] },
    viewerCookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().completionEvents, 1);
});
