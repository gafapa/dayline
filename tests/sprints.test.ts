import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { capacityHours, emptyCeremony, sprintMetrics } from "../shared/sprints";
import type { Resource } from "../shared/model";
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  ownerId: string,
  ownerCookie: string,
  memberId: string,
  memberCookie: string,
  viewerCookie: string;
const headers = { origin: "http://test.local", "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1" };
const request = (
  method: any,
  path: string,
  payload?: any,
  cookie = ownerCookie,
) =>
  api.app.inject({
    method,
    url: path,
    payload,
    headers: { ...headers, cookie },
  });
const base = (id: string) => `/api/workspaces/${workspaceId}/sprints/${id}`;
async function make(
  kind: string,
  title: string,
  data: any = {},
  cookie = ownerCookie,
) {
  const result = await request(
    "POST",
    `/api/workspaces/${workspaceId}/mutate`,
    {
      id: randomUUID(),
      kind,
      title,
      data,
      expectedVersion: 0,
      operationId: randomUUID(),
    },
    cookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  return result.json().resource as Resource;
}
async function edit(resource: Resource, data: any, cookie = ownerCookie) {
  const result = await request(
    "POST",
    `/api/workspaces/${workspaceId}/mutate`,
    {
      id: resource.id,
      kind: resource.kind,
      title: resource.title,
      data: { ...resource.data, ...data },
      expectedVersion: resource.version,
      operationId: randomUUID(),
    },
    cookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  return result.json().resource as Resource;
}
const current = async (id: string) =>
  (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id]))
    .rows[0];
async function invite(email: string, role: string) {
  const invitation = await request(
    "POST",
    `/api/workspaces/${workspaceId}/invitations`,
    { email, role },
  );
  assert.equal(invitation.statusCode, 200, invitation.body);
  const token = new URL(invitation.json().url).searchParams.get("invitation"),
    accepted = await request("POST", "/api/invitations/accept", {
      email,
      role,
      name: email,
      password: "invited-password-long",
      token,
    });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const cookie = accepted.headers["set-cookie"]!.toString().split(";")[0];
  return {
    cookie,
    id: (await request("GET", "/api/me", undefined, cookie)).json().user.id,
  };
}
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, {
    origin: "http://test.local",
    setupToken: "test-setup-token",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await request(
    "POST",
    "/api/setup",
    {
      email: "sprint-owner@example.test",
      password: "test-password-long-enough",
      name: "Owner",
      workspaceName: "Sprint qualification",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
  const member = await invite("sprint-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerCookie = (await invite("sprint-viewer@example.test", "viewer")).cookie;
});
after(async () => {
  await api.app.close();
  await db.close();
});
const planBody = (sprint: Resource, tasks: Resource[], patch: any = {}) => ({
  operationId: randomUUID(),
  expectedVersion: sprint.version,
  taskIds: tasks.map((task) => task.id),
  taskVersions: tasks.map((task) => ({ id: task.id, version: task.version })),
  capacityPlan: [],
  definitionOfDone: "Reviewed and tested",
  checklist: [],
  ...patch,
});
test("capacity, ordering and planning retries are atomic and reject stale task versions", async () => {
  let sprint = await make("sprint", "Planning sprint", { status: "planned" });
  const a = await make("task", "First backlog issue", {
      status: "todo",
      estimate: 3,
      assigneeId: memberId,
    }),
    b = await make("task", "Second backlog issue", {
      status: "todo",
      estimate: 5,
    });
  const capacity = {
    userId: memberId,
    days: 10,
    hoursPerDay: 6,
    focusPercent: 75,
    points: 5,
  };
  assert.equal(capacityHours(capacity), 45);
  const body = planBody(sprint, [b, a], { capacityPlan: [capacity] });
  const saved = await request("PUT", base(sprint.id) + "/planning", body);
  assert.equal(saved.statusCode, 200, saved.body);
  sprint = saved.json().resource;
  assert.equal((await current(b.id)).data.order, 0);
  assert.equal((await current(a.id)).data.order, 1024);
  assert.equal((await current(a.id)).data.sprintId, sprint.id);
  assert.equal(
    (await request("PUT", base(sprint.id) + "/planning", body)).statusCode,
    200,
  );
  assert.equal((await current(a.id)).version, 2);
  const changed = await edit(await current(a.id), { estimate: 8 });
  const stale = await request(
    "PUT",
    base(sprint.id) + "/planning",
    planBody(
      sprint,
      [await current(b.id), { ...changed, version: changed.version - 1 }],
      { capacityPlan: [{ ...capacity, points: 20 }] },
    ),
  );
  assert.equal(stale.statusCode, 409);
  assert.equal((await current(sprint.id)).data.capacityPlan[0].points, 5);
  const invalid = await request(
    "PUT",
    base(sprint.id) + "/planning",
    planBody(sprint, [changed, await current(b.id)], {
      capacityPlan: [{ ...capacity, userId: randomUUID() }],
    }),
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal((await current(sprint.id)).version, sprint.version);
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + "/planning",
        planBody(sprint, [changed, await current(b.id)]),
        viewerCookie,
      )
    ).statusCode,
    403,
  );
});
test("starting freezes the initial scope and closing preserves metrics after later task edits", async () => {
  let sprint = await make("sprint", "Historical sprint", {
    status: "planned",
    startDate: "2026-01-01",
    endDate: "2026-01-14",
  });
  let task = await make("task", "Historical delivery", {
    status: "todo",
    sprintId: sprint.id,
    estimate: 3,
  });
  const operation = {
    operationId: randomUUID(),
    expectedVersion: sprint.version,
  };
  const started = await request("POST", base(sprint.id) + "/start", operation);
  assert.equal(started.statusCode, 200, started.body);
  sprint = started.json().resource;
  assert.equal(
    (await request("POST", base(sprint.id) + "/start", operation)).statusCode,
    200,
  );
  task = await edit(task, { status: "in_progress", estimate: 8 });
  task = await edit(task, { status: "done" });
  const metrics = (await request("GET", base(sprint.id) + "/metrics")).json();
  assert.equal(metrics.available, true);
  assert.equal(metrics.baseline.scope, 3);
  assert.equal(metrics.final.scope, 8);
  assert.equal(metrics.final.done, 8);
  assert.ok(metrics.changes.some((change: any) => change.type === "estimate"));
  const closed = await request("POST", base(sprint.id) + "/close", {
    expectedVersion: sprint.version,
    expectedTasks: [{ id: task.id, version: task.version }],
  });
  assert.equal(closed.statusCode, 200, closed.body);
  await edit(task, { estimate: 100 });
  const after = (await request("GET", base(sprint.id) + "/metrics")).json();
  assert.equal(after.baseline.scope, 3);
  assert.equal(after.final.scope, 8);
  assert.equal(after.final.done, 8);
  const attach = await request(
    "POST",
    `/api/workspaces/${workspaceId}/mutate`,
    {
      id: randomUUID(),
      operationId: randomUUID(),
      kind: "task",
      title: "Late task",
      data: { status: "todo", sprintId: sprint.id },
      expectedVersion: 0,
    },
  );
  assert.equal(attach.statusCode, 409);
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + "/planning",
        planBody(closed.json().resource, []),
      )
    ).statusCode,
    409,
  );
});
test("closure checks task versions and completion exceptions before rollover", async () => {
  const sprint = await make("sprint", "Closure exceptions", {
      status: "active",
      checklist: [
        { id: "criterion", text: "Stakeholder accepted", done: false },
      ],
    }),
    next = await make("sprint", "Next sprint", { status: "planned" }),
    pending = await make("task", "Pending work", {
      status: "todo",
      sprintId: sprint.id,
    }),
    done = await make("task", "Unchecked delivery", {
      status: "done",
      sprintId: sprint.id,
      checklist: [{ id: "test", text: "Test result", done: false }],
    });
  const stale = await request("POST", base(sprint.id) + "/close", {
    expectedVersion: sprint.version,
    expectedTasks: [{ id: pending.id, version: 1 }],
  });
  assert.equal(stale.statusCode, 409);
  const warning = await request("POST", base(sprint.id) + "/close", {
    expectedVersion: sprint.version,
  });
  assert.equal(warning.statusCode, 409);
  assert.equal(warning.json().detail.requiresAcknowledgement, true);
  assert.equal((await current(pending.id)).data.sprintId, sprint.id);
  const closed = await request("POST", base(sprint.id) + "/close", {
    expectedVersion: sprint.version,
    rolloverSprintId: next.id,
    acknowledgeIncomplete: true,
    expectedTasks: [
      { id: pending.id, version: 1 },
      { id: done.id, version: 1 },
    ],
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal((await current(pending.id)).data.sprintId, next.id);
  assert.equal(closed.json().resource.data.snapshot.length, 2);
});
test("planning, baseline, metrics and review history respect current private-project visibility", async () => {
  const project = await make("project", "Hidden delivery", {
      private: true,
      members: [],
    }),
    sprint = await make("sprint", "Mixed visibility", { status: "planned" }),
    secret = await make("task", "Hidden task", {
      projectId: project.id,
      status: "todo",
      sprintId: sprint.id,
      estimate: 13,
    }),
    visible = await make("task", "Visible task", {
      status: "todo",
      sprintId: sprint.id,
      estimate: 3,
    });
  const memberPlan = (
    await request("GET", base(sprint.id) + "/planning", undefined, memberCookie)
  ).json();
  assert.ok(!memberPlan.tasks.some((task: Resource) => task.id === secret.id));
  assert.equal(
    (
      await request(
        "POST",
        base(sprint.id) + "/start",
        { operationId: randomUUID(), expectedVersion: 1 },
        memberCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + "/planning",
        planBody(sprint, [visible]),
        memberCookie,
      )
    ).statusCode,
    403,
  );
  const started = await request("POST", base(sprint.id) + "/start", {
    operationId: randomUUID(),
    expectedVersion: 1,
  });
  assert.equal(started.statusCode, 200);
  const baseline = (
    await request("GET", base(sprint.id) + "/planning", undefined, memberCookie)
  ).json().baseline;
  assert.ok(!baseline.tasks.some((task: Resource) => task.id === secret.id));
  const metrics = (
    await request("GET", base(sprint.id) + "/metrics", undefined, memberCookie)
  ).json();
  assert.equal(metrics.baseline.scope, 3);
  assert.equal(metrics.final.scope, 3);
  const data = emptyCeremony();
  data.retrospective.actionIds = [secret.id];
  data.review.delivered = "Reviewed";
  const saved = await request("PUT", base(sprint.id) + "/ceremonies", {
    operationId: randomUUID(),
    expectedVersion: 0,
    data,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(
    (
      await request(
        "GET",
        base(sprint.id) + "/ceremonies",
        undefined,
        memberCookie,
      )
    ).json().data.retrospective.actionIds,
    [],
  );
  assert.deepEqual(
    (
      await request(
        "GET",
        base(sprint.id) + "/ceremonies/versions",
        undefined,
        memberCookie,
      )
    ).json().versions[0].data.retrospective.actionIds,
    [],
  );
});
test("poker votes stay hidden until reveal and applying consensus is explicit, versioned and idempotent", async () => {
  const sprint = await make("sprint", "Poker sprint", { status: "planned" });
  let task = await make("task", "Estimate this issue", {
    status: "todo",
    sprintId: sprint.id,
    estimate: 1,
  });
  const created = await request("POST", base(sprint.id) + "/poker", {
    operationId: randomUUID(),
    taskId: task.id,
    expectedTaskVersion: task.version,
  });
  assert.equal(created.statusCode, 200, created.body);
  const round = created.json().round;
  assert.equal(
    (
      await request("PUT", base(sprint.id) + `/poker/${round.id}/vote`, {
        value: "3",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + `/poker/${round.id}/vote`,
        { value: "13" },
        memberCookie,
      )
    ).statusCode,
    200,
  );
  const hidden = (await request("GET", base(sprint.id) + "/poker")).json()
    .rounds[0];
  assert.equal(hidden.ownVote, "3");
  assert.ok(
    hidden.participants.every(
      (participant: any) => participant.value === undefined,
    ),
  );
  assert.ok(!JSON.stringify(hidden).includes('"13"'));
  const viewer = (
    await request("GET", base(sprint.id) + "/poker", undefined, viewerCookie)
  ).json().rounds[0];
  assert.equal(viewer.ownVote, null);
  assert.ok(
    viewer.participants.every(
      (participant: any) => participant.value === undefined,
    ),
  );
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + `/poker/${round.id}/vote`,
        { value: "8" },
        viewerCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        base(sprint.id) + `/poker/${round.id}/reveal`,
        { operationId: randomUUID(), expectedVersion: 1 },
        memberCookie,
      )
    ).statusCode,
    403,
  );
  const revealed = await request(
    "POST",
    base(sprint.id) + `/poker/${round.id}/reveal`,
    { operationId: randomUUID(), expectedVersion: 1 },
  );
  assert.equal(revealed.statusCode, 200, revealed.body);
  assert.deepEqual(
    revealed
      .json()
      .round.participants.map((participant: any) => participant.value)
      .sort(),
    ["13", "3"],
  );
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + `/poker/${round.id}/vote`,
        { value: "8" },
        memberCookie,
      )
    ).statusCode,
    409,
  );
  task = await edit(task, { priority: "high" });
  const stale = await request(
    "POST",
    base(sprint.id) + `/poker/${round.id}/apply`,
    {
      operationId: randomUUID(),
      expectedVersion: 2,
      expectedTaskVersion: 1,
      estimate: 8,
    },
  );
  assert.equal(stale.statusCode, 409);
  assert.equal((await current(task.id)).data.estimate, 1);
  const body = {
      operationId: randomUUID(),
      expectedVersion: 2,
      expectedTaskVersion: task.version,
      estimate: 8,
    },
    applied = await request(
      "POST",
      base(sprint.id) + `/poker/${round.id}/apply`,
      body,
    );
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal((await current(task.id)).data.estimate, 8);
  assert.equal((await current(task.id)).version, 3);
  assert.equal(
    (await request("POST", base(sprint.id) + `/poker/${round.id}/apply`, body))
      .statusCode,
    200,
  );
  assert.equal((await current(task.id)).version, 3);
});
test("only one open round is created concurrently and closing cancels unfinished rounds without revealing votes", async () => {
  const sprint = await make("sprint", "Concurrent poker", { status: "active" }),
    task = await make("task", "Concurrent round target", {
      status: "todo",
      sprintId: sprint.id,
    });
  const responses = await Promise.all([
    request("POST", base(sprint.id) + "/poker", {
      operationId: randomUUID(),
      taskId: task.id,
      expectedTaskVersion: 1,
    }),
    request(
      "POST",
      base(sprint.id) + "/poker",
      { operationId: randomUUID(), taskId: task.id, expectedTaskVersion: 1 },
      memberCookie,
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  const round = responses
    .find((response) => response.statusCode === 200)!
    .json().round;
  await request(
    "PUT",
    base(sprint.id) + `/poker/${round.id}/vote`,
    { value: "13" },
    memberCookie,
  );
  assert.equal(
    (await request("POST", base(sprint.id) + "/close", { expectedVersion: 1 }))
      .statusCode,
    200,
  );
  const closed = (await request("GET", base(sprint.id) + "/poker")).json()
    .rounds[0];
  assert.equal(closed.status, "cancelled");
  assert.ok(
    closed.participants.every(
      (participant: any) => participant.value === undefined,
    ),
  );
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + `/poker/${round.id}/vote`,
        { value: "5" },
        memberCookie,
      )
    ).statusCode,
    409,
  );
});
test("review notes can evolve after closure while closure snapshots remain immutable and history is retained", async () => {
  const sprint = await make("sprint", "Review after closure", {
      status: "active",
    }),
    task = await make("task", "Follow-up action", { status: "backlog" });
  const closed = await request("POST", base(sprint.id) + "/close", {
    expectedVersion: 1,
  });
  assert.equal(closed.statusCode, 200);
  const first = emptyCeremony();
  first.review.outcome = "partial";
  first.review.delivered = "Delivered the public slice";
  first.retrospective.actionIds = [task.id];
  const body = { operationId: randomUUID(), expectedVersion: 0, data: first };
  assert.equal(
    (await request("PUT", base(sprint.id) + "/ceremonies", body, memberCookie))
      .statusCode,
    200,
  );
  assert.equal(
    (await request("PUT", base(sprint.id) + "/ceremonies", body, memberCookie))
      .statusCode,
    200,
  );
  const second = {
    ...first,
    review: { ...first.review, feedback: "Reviewed together" },
  };
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + "/ceremonies",
        { operationId: randomUUID(), expectedVersion: 1, data: second },
        memberCookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request("PUT", base(sprint.id) + "/ceremonies", {
        operationId: randomUUID(),
        expectedVersion: 1,
        data: first,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(
        "PUT",
        base(sprint.id) + "/ceremonies",
        { operationId: randomUUID(), expectedVersion: 2, data: first },
        viewerCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", base(sprint.id) + "/ceremonies/versions")).json()
      .versions.length,
    2,
  );
  assert.equal(
    (await current(sprint.id)).version,
    closed.json().resource.version,
  );
  assert.deepEqual((await current(sprint.id)).data.snapshot, []);
});
test("metrics derive scope and first-delivery durations from real version events", () => {
  const sprintId = randomUUID(),
    resource = (
      id: string,
      version: number,
      status: string,
      estimate: number,
      at: string,
      sprint: string | null,
    ) =>
      ({
        id,
        workspace_id: workspaceId,
        kind: "task",
        title: id,
        data: { sprintId: sprint, status, estimate },
        version,
        created_by: ownerId,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      }) as Resource;
  const a = resource(
      randomUUID(),
      1,
      "todo",
      3,
      "2026-01-01T00:00:00Z",
      sprintId,
    ),
    b = resource(
      randomUUID(),
      1,
      "in_progress",
      5,
      "2026-01-02T00:00:00Z",
      sprintId,
    ),
    completed = { ...b, version: 2, data: { ...b.data, status: "done" } };
  const history = [
    { snapshot: b, version: 1, created_at: "2026-01-02T00:00:00Z" },
    {
      snapshot: { ...a, version: 2, data: { ...a.data, estimate: 8 } },
      version: 2,
      created_at: "2026-01-03T00:00:00Z",
    },
    { snapshot: completed, version: 2, created_at: "2026-01-04T00:00:00Z" },
    {
      snapshot: { ...a, version: 3, data: { ...a.data, sprintId: null } },
      version: 3,
      created_at: "2026-01-05T00:00:00Z",
    },
  ];
  const metrics = sprintMetrics(
    sprintId,
    [a],
    "2026-01-01T00:00:00Z",
    history,
    "2026-01-05T00:00:00Z",
  );
  assert.equal(metrics.baseline.scope, 3);
  assert.equal(metrics.final.scope, 5);
  assert.equal(metrics.final.done, 5);
  assert.equal(metrics.series.at(-1).remaining, 0);
  assert.deepEqual(
    metrics.changes.map((change) => change.type),
    ["added", "estimate", "removed"],
  );
  assert.equal(metrics.leadHours, 48);
  assert.equal(metrics.cycleHours, 48);
  const intraday = sprintMetrics(
    sprintId,
    [a],
    "2026-01-01T00:00:00Z",
    [
      {
        snapshot: { ...a, version: 2, data: { ...a.data, estimate: 8 } },
        version: 2,
        created_at: "2026-01-01T00:30:00Z",
      },
    ],
    "2026-01-01T01:00:00Z",
  );
  assert.ok(
    intraday.series.some(
      (point) => point.at === "2026-01-01T00:30:00Z" && point.scope === 8,
    ),
  );
  assert.equal(intraday.sampled, false);
});
test("publishing a task does not publish its earlier private sprint history or poker context", async () => {
  const project = await make("project", "Original private context", {
      private: true,
      members: [],
    }),
    sprint = await make("sprint", "Historical privacy", { status: "planned" });
  let task = await make("task", "Previously private estimate", {
    projectId: project.id,
    sprintId: sprint.id,
    status: "todo",
    estimate: 3,
  });
  const created = await request("POST", base(sprint.id) + "/poker", {
    operationId: randomUUID(),
    taskId: task.id,
    expectedTaskVersion: 1,
  });
  assert.equal(created.statusCode, 200, created.body);
  const round = created.json().round;
  await request("PUT", base(sprint.id) + `/poker/${round.id}/vote`, {
    value: "3",
  });
  await request("POST", base(sprint.id) + `/poker/${round.id}/reveal`, {
    operationId: randomUUID(),
    expectedVersion: 1,
  });
  await request("POST", base(sprint.id) + `/poker/${round.id}/cancel`, {
    operationId: randomUUID(),
    expectedVersion: 2,
  });
  task = await edit(task, { status: "done" });
  const started = await request("POST", base(sprint.id) + "/start", {
    operationId: randomUUID(),
    expectedVersion: 1,
  });
  assert.equal(started.statusCode, 200);
  assert.equal(
    (
      await request("POST", base(sprint.id) + "/close", {
        expectedVersion: started.json().resource.version,
      })
    ).statusCode,
    200,
  );
  await edit(task, { projectId: null, estimate: 99 });
  const snapshot = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/resources`,
      undefined,
      memberCookie,
    )
  ).json();
  assert.ok(
    snapshot.resources.some((resource: Resource) => resource.id === task.id),
  );
  assert.equal(
    snapshot.resources.find((resource: Resource) => resource.id === sprint.id)
      .data.snapshot.length,
    0,
  );
  const plan = (
    await request("GET", base(sprint.id) + "/planning", undefined, memberCookie)
  ).json();
  assert.equal(plan.baseline.tasks.length, 0);
  assert.equal(plan.tasks.length, 0);
  const metrics = (
    await request("GET", base(sprint.id) + "/metrics", undefined, memberCookie)
  ).json();
  assert.equal(metrics.baseline.scope, 0);
  assert.equal(metrics.final.scope, 0);
  assert.equal(
    (
      await request("GET", base(sprint.id) + "/poker", undefined, memberCookie)
    ).json().rounds.length,
    0,
  );
  const versions = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/resources/${task.id}/versions`,
      undefined,
      memberCookie,
    )
  ).json().versions;
  // Versions visible to the member never reveal the private project (the task now sits in General).
  assert.ok(versions.every((entry: any) => entry.snapshot.data.projectId !== project.id));
  assert.equal(
    (await request("GET", base(sprint.id) + "/planning")).json().baseline.tasks
      .length,
    1,
  );
});
