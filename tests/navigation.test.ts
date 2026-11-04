import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { documentExtensions } from "../shared/editor-schema";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { readAppRoute, resourceHref, pageHref } from "../shared/navigation";
import { documentText } from "../shared/documents";
import type { Resource } from "../shared/model";
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  ownerId: string,
  ownerCookie: string,
  memberId: string,
  memberCookie: string,
  viewerCookie: string;
const headers = {
  origin: "http://test.local",
  "x-kelvin-client": "web",
  "X-Kelvin-Document-Schema": "1",
};
const request = (
  method: any,
  url: string,
  payload?: any,
  cookie = ownerCookie,
) => api.app.inject({ method, url, payload, headers: { ...headers, cookie } });
const base = () => `/api/workspaces/${workspaceId}`;
async function make(
  kind: string,
  title: string,
  data: any = {},
  cookie = ownerCookie,
) {
  const response = await request(
    "POST",
    base() + "/mutate",
    {
      id: randomUUID(),
      kind,
      title,
      data,
      operationId: randomUUID(),
      expectedVersion: 0,
    },
    cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
async function edit(resource: Resource, data: any, cookie = ownerCookie) {
  const response = await request(
    "POST",
    base() + "/mutate",
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
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
const current = async (id: string) =>
  (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id]))
    .rows[0];
async function invite(email: string, role: string) {
  const invitation = await request("POST", base() + "/invitations", {
    email,
    role,
  });
  assert.equal(invitation.statusCode, 200, invitation.body);
  const accepted = await request("POST", "/api/invitations/accept", {
    email,
    role,
    name: email,
    password: "invited-password-long",
    token: new URL(invitation.json().url).searchParams.get("invitation"),
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
      email: "navigation-owner@example.test",
      password: "test-password-long-enough",
      name: "Owner",
      workspaceName: "Navigation tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  ownerId = me.user.id;
  workspaceId = me.workspaces[0].id;
  const member = await invite("navigation-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerCookie = (await invite("navigation-viewer@example.test", "viewer"))
    .cookie;
});
after(async () => {
  await api.app.close();
  await db.close();
});

test("resource links accept only canonical same-origin destinations and unambiguous identifiers", () => {
  const id = randomUUID(),
    workspace = randomUUID(),
    origin = "https://organizer.example.test";
  assert.deepEqual(
    readAppRoute(resourceHref(id.toUpperCase(), origin), origin),
    { type: "resource", id },
  );
  assert.deepEqual(readAppRoute(resourceHref(id, origin), origin), {
    type: "resource",
    id,
  });
  assert.deepEqual(readAppRoute(pageHref("tasks", workspace, id), origin), {
    type: "page",
    page: "tasks",
    workspaceId: workspace,
    projectId: id,
  });
  assert.equal(
    readAppRoute(`https://external.example.test/?resource=${id}`, origin),
    null,
  );
  assert.equal(readAppRoute(`/api/attachments?resource=${id}`, origin), null);
  assert.deepEqual(readAppRoute(`/?resource=${id}&resource=${id}`, origin), {
    type: "invalid",
  });
  assert.deepEqual(readAppRoute("/?resource=javascript:alert(1)", origin), {
    type: "invalid",
  });
  assert.deepEqual(readAppRoute("/?view=unknown", origin), { type: "invalid" });
  assert.equal(
    readAppRoute("/?invitation=unconsumed-invitation", origin),
    null,
  );
});

test("location resolves an authorized resource across workspaces without disclosing its contents", async () => {
  const created = await request("POST", "/api/workspaces", {
    name: "Second navigation workspace",
  });
  assert.equal(created.statusCode, 200);
  const workspace = created.json(),
    resourceId = randomUUID(),
    resource = await request("POST", `/api/workspaces/${workspace.id}/mutate`, {
      operationId: randomUUID(),
      id: resourceId,
      kind: "document",
      title: "Cross-workspace document",
      data: { description: "Private fixture content" },
      expectedVersion: 0,
    });
  assert.equal(resource.statusCode, 200, resource.body);
  const location = await request(
    "GET",
    `/api/resources/${resourceId}/location`,
  );
  assert.equal(location.statusCode, 200);
  assert.equal(location.headers["cache-control"], "no-store");
  assert.deepEqual(location.json(), { resourceId, workspace });
  assert.ok(!location.body.includes("Private fixture content"));
  const inaccessible = await request(
    "GET",
    `/api/resources/${resourceId}/location`,
    undefined,
    memberCookie,
  );
  assert.equal(inaccessible.statusCode, 404);
  assert.ok(!inaccessible.body.includes(workspace.name));
});

test("nonexistent, deleted and private targets have the same opaque location denial", async () => {
  const project = await make("project", "Private navigation project", {
      private: true,
    }),
    privateTask = await make("task", "Confidential link target", {
      projectId: project.id,
      status: "todo",
    }),
    removed = await make("task", "Removed link target", { status: "todo" });
  await request("POST", base() + "/mutate", {
    operationId: randomUUID(),
    id: removed.id,
    kind: removed.kind,
    title: removed.title,
    data: removed.data,
    expectedVersion: removed.version,
    deleted: true,
  });
  const results = await Promise.all(
    [privateTask.id, removed.id, randomUUID()].map((id) =>
      request("GET", `/api/resources/${id}/location`, undefined, memberCookie),
    ),
  );
  assert.ok(results.every((result) => result.statusCode === 404));
  assert.deepEqual(
    results.map((result) => result.json().error),
    [results[0].json().error, results[0].json().error, results[0].json().error],
  );
  assert.equal(
    (
      await request(
        "GET",
        `/api/resources/${privateTask.id}/location`,
        undefined,
        "",
      )
    ).statusCode,
    401,
  );
});

test("current membership and personal ownership are rechecked for every location request", async () => {
  const document = await make("document", "Personal navigation note", {
      ownerId: ownerId,
    }),
    task = await make("task", "Membership navigation task", { status: "todo" });
  await db.query(
    "UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, memberId],
  );
  assert.equal(
    (
      await request(
        "GET",
        `/api/resources/${document.id}/location`,
        undefined,
        memberCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/api/resources/${task.id}/location`,
        undefined,
        memberCookie,
      )
    ).statusCode,
    200,
  );
  await db.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, memberId],
  );
  assert.equal(
    (
      await request(
        "GET",
        `/api/resources/${task.id}/location`,
        undefined,
        memberCookie,
      )
    ).statusCode,
    404,
  );
});

test("archived targets remain readable and workspace snapshots identify current read-only access", async () => {
  const task = await make("task", "Archived navigation target", {
    status: "done",
    archived: true,
  });
  assert.equal(
    (
      await request(
        "GET",
        `/api/resources/${task.id}/location`,
        undefined,
        viewerCookie,
      )
    ).statusCode,
    200,
  );
  const snapshot = await request(
    "GET",
    base() + "/resources",
    undefined,
    viewerCookie,
  );
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().workspace.id, workspaceId);
  assert.equal(snapshot.json().workspace.role, "viewer");
  assert.equal(snapshot.headers["cache-control"], "no-store");
});

test("directory routes retain their workspace and container and reject ambiguous locations", () => {
  const workspace = randomUUID(),
    container = randomUUID(),
    origin = "https://organizer.example.test";
  assert.deepEqual(
    readAppRoute(pageHref("projects", workspace, undefined, container), origin),
    {
      type: "page",
      page: "projects",
      workspaceId: workspace,
      containerId: container,
    },
  );
  for (const href of [
    `/?view=tasks&location=${container}`,
    `/?view=projects&location=${container}&location=${container}`,
    "/?view=projects&view=tasks",
  ])
    assert.deepEqual(readAppRoute(href, origin), { type: "invalid" });
});

test("dashboard backdrops retain a validated report context", () => {
  const dashboard = "b9a9b16f-9a1f-4ea6-bc47-96c2bfab0001",
    target = "b9a9b16f-9a1f-4ea6-bc47-96c2bfab0002",
    origin = "https://organizer.example.test";
  const route = readAppRoute(`/?resource=${target}`, origin, {
    kelvin: { backdrop: { page: "reports", dashboardId: dashboard } },
  });
  assert.equal(route?.type, "resource");
  if (route?.type === "resource")
    assert.equal(route.backdrop?.dashboardId, dashboard);
  const rejected = readAppRoute(`/?resource=${target}`, origin, {
    kelvin: { backdrop: { page: "reports", dashboardId: "not-an-id" } },
  });
  if (rejected?.type === "resource")
    assert.equal(rejected.backdrop?.dashboardId, undefined);
});
