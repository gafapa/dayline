import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import {
  boardColumns,
  effectiveState,
  normalizeTaskState,
  stateLabel,
  stateOptions,
} from "../shared/workflow";
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
      email: "workflow-owner@example.test",
      password: "test-password-long-enough",
      name: "Workflow owner",
      workspaceName: "Workflow tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
  const member = await invite("workflow-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerId = (await invite("workflow-viewer@example.test", "viewer")).id;
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
const ids = {
  triage: randomUUID(),
  doing: randomUUID(),
  qa: randomUUID(),
  shipped: randomUUID(),
};
const states = [
  { id: ids.triage, name: "Triaje", category: "todo", archived: false },
  { id: ids.doing, name: "Desarrollo", category: "in_progress", archived: false },
  { id: ids.qa, name: "QA", category: "review", archived: false },
  { id: ids.shipped, name: "Publicado", category: "done", archived: false },
];
const withStates = (project: Resource, next: any[]) =>
  mutate(
    "project",
    project.title,
    { ...project.data, workflowStates: next },
    project.id,
    project.version,
  );
test("named states keep their category, are archived instead of removed and only managers configure them", async () => {
  const project = await make("project", "Workflow project", {
    workflowStates: states,
  });
  assert.equal(project.data.workflowStates.length, 4);
  assert.equal((await withStates(project, states.slice(1))).statusCode, 409);
  assert.equal(
    (
      await withStates(
        project,
        states.map((s) => (s.id === ids.qa ? { ...s, category: "done" } : s)),
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await withStates(project, [
        ...states,
        { id: randomUUID(), name: "qa", category: "todo", archived: false },
      ])
    ).statusCode,
    400,
  );
  const memberChange = await mutate(
    "project",
    project.title,
    {
      ...project.data,
      workflowStates: [
        ...states,
        { id: randomUUID(), name: "Bloqueado", category: "in_progress" },
      ],
    },
    project.id,
    project.version,
    memberCookie,
  );
  assert.equal(memberChange.statusCode, 403);
  const renamed = await edit(project, {
    workflowStates: states.map((s) =>
      s.id === ids.qa ? { ...s, name: "Validación" } : s,
    ),
  });
  assert.equal(
    renamed.data.workflowStates.find((s: any) => s.id === ids.qa).name,
    "Validación",
  );
  assert.equal(
    (await mutate("task", "Misplaced", { workflowStates: states })).statusCode,
    400,
  );
  assert.equal(
    (await mutate("document", "Misplaced", { stateId: ids.qa })).statusCode,
    400,
  );
});
test("tasks keep a valid named state, drop stale references and refuse newly assigned archived states", async () => {
  const project = await make("project", "State tasks", {
    workflowStates: states,
  });
  const task = await make("task", "Named", {
    projectId: project.id,
    status: "review",
    stateId: ids.qa,
  });
  assert.equal(task.data.stateId, ids.qa);
  const mismatched = await make("task", "Mismatch", {
    projectId: project.id,
    status: "todo",
    stateId: ids.qa,
  });
  assert.equal(mismatched.data.stateId, undefined);
  const moved = await edit(task, { status: "done" });
  assert.equal(moved.data.stateId, undefined);
  const shipped = await edit(moved, { stateId: ids.shipped });
  assert.equal(shipped.data.stateId, ids.shipped);
  const other = await make("project", "No workflow");
  const transferred = await edit(shipped, { projectId: other.id });
  assert.equal(transferred.data.stateId, undefined);
  const keeper = await make("task", "Keeper", {
    projectId: project.id,
    status: "in_progress",
    stateId: ids.doing,
  });
  await edit(project, {
    workflowStates: states.map((s) =>
      s.id === ids.doing ? { ...s, archived: true } : s,
    ),
  });
  const retained = await edit(await current(keeper.id), {
    description: "still in development",
  });
  assert.equal(retained.data.stateId, ids.doing);
  const newcomer = await make("task", "Newcomer", {
    projectId: project.id,
    status: "todo",
  });
  const refused = await mutate(
    "task",
    newcomer.title,
    { ...newcomer.data, status: "in_progress", stateId: ids.doing },
    newcomer.id,
    newcomer.version,
  );
  assert.equal(refused.statusCode, 409, refused.body);
});
test("status automations leave no stale named state", async () => {
  const project = await make("project", "Automated workflow", {
    workflowStates: states,
  });
  await make("automation", "Send to review", {
    projectId: project.id,
    enabled: true,
    trigger: "task_created",
    action: "set_status",
    actionValue: "review",
  });
  const task = await make("task", "Automated", {
    projectId: project.id,
    status: "todo",
    stateId: ids.triage,
  });
  await api.automations.tick(new Date(), workspaceId);
  const updated = await current(task.id);
  assert.equal(updated.data.status, "review");
  assert.equal(updated.data.stateId, undefined);
  assert.equal(stateLabel(updated, [project]), "QA");
});
test("display helpers fall back to the first active state and keep archived columns with tasks", () => {
  const archivedId = randomUUID();
  const project = {
    id: randomUUID(),
    kind: "project",
    data: {
      workflowStates: [
        ...states,
        { id: archivedId, name: "Antiguo", category: "todo", archived: true },
      ],
    },
  } as any;
  const task = (status: string, stateId?: string, projectId = project.id) =>
    ({
      id: randomUUID(),
      kind: "task",
      title: status,
      data: { projectId, status, ...(stateId ? { stateId } : {}) },
    }) as any;
  assert.equal(effectiveState(task("todo"), [project])?.name, "Triaje");
  assert.equal(stateLabel(task("backlog"), [project]), "Backlog");
  assert.equal(stateLabel(task("todo", archivedId), [project]), "Antiguo");
  assert.deepEqual(
    stateOptions(project).map((o) => o.label),
    ["Backlog", "Triaje", "Desarrollo", "QA", "Publicado", "Cancelada"],
  );
  assert.ok(
    stateOptions(project, task("todo", archivedId)).some(
      (o) => o.label === "Antiguo (archivado)",
    ),
  );
  const tasks = [
    task("todo"),
    task("todo", archivedId),
    task("done"),
    task("cancelled"),
  ];
  assert.deepEqual(
    boardColumns(tasks, [project]).map((c) => [c.label, c.tasks.length]),
    [
      ["Backlog", 0],
      ["Triaje", 1],
      ["Antiguo (archivado)", 1],
      ["Desarrollo", 0],
      ["QA", 0],
      ["Publicado", 1],
      ["Cancelada", 1],
    ],
  );
  const mixed = boardColumns(
    [...tasks, task("todo", undefined, randomUUID())],
    [project],
  );
  assert.equal(mixed.find((c) => c.value === "todo")!.tasks.length, 3);
  assert.equal(
    normalizeTaskState({ status: "todo", stateId: ids.qa }, undefined, project)
      .stateId,
    undefined,
  );
  assert.throws(
    () =>
      normalizeTaskState({ status: "todo", stateId: archivedId }, {}, project),
    /archivado/,
  );
});


test("a state's WIP limit reaches its board column and is validated", () => {
  const id = randomUUID();
  const project = {
    id: randomUUID(),
    kind: "project",
    title: "P",
    data: { workflowStates: [{ id, name: "Desarrollo", category: "in_progress", archived: false, limit: 3 }] },
  } as unknown as Resource;
  const task = { id: randomUUID(), kind: "task", title: "T", data: { projectId: project.id, status: "todo" } } as unknown as Resource;
  const column = boardColumns([task], [project]).find((c) => c.stateId === id);
  assert.equal(column?.limit, 3);
  const bad = { ...project, data: { workflowStates: [{ id, name: "X", category: "todo", limit: 0 }] } } as unknown as Resource;
  assert.equal(stateOptions(bad).some((o) => o.limit), false);
});
