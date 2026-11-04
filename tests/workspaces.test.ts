import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
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
      email: "spaces-owner@example.test",
      password: "test-password-long-enough",
      name: "Spaces owner",
      workspaceName: "Spaces tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
  const member = await invite("spaces-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerId = (await invite("spaces-viewer@example.test", "viewer")).id;
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

const list = async (cookie = ownerCookie) =>
  (await request("GET", "/api/workspaces", undefined, cookie)).json().workspaces;
test("workspace list reports role and member counts and admins can rename", async () => {
  const spaces = await list();
  const main = spaces.find((w: any) => w.id === workspaceId);
  assert.equal(main.role, "admin");
  assert.equal(main.member_count, 3);
  assert.equal(main.admin_count, 1);
  const renamed = await request("PATCH", `/api/workspaces/${workspaceId}`, { name: "  Producto  " });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().name, "Producto");
  assert.equal((await list()).find((w: any) => w.id === workspaceId).name, "Producto");
  assert.equal(
    (await request("PATCH", `/api/workspaces/${workspaceId}`, { name: "Miembro" }, memberCookie)).statusCode,
    403,
  );
  assert.equal((await request("PATCH", `/api/workspaces/${workspaceId}`, { name: "" })).statusCode, 400);
  assert.equal(
    (await request("PATCH", `/api/workspaces/${workspaceId}`, { name: "X", extra: 1 })).statusCode,
    400,
  );
  const outsider = randomUUID();
  assert.equal((await request("PATCH", `/api/workspaces/${outsider}`, { name: "Ajeno" })).statusCode, 403);
});
test("leaving keeps a last administrator and never removes the only workspace", async () => {
  assert.equal(
    (await request("POST", `/api/workspaces/${workspaceId}/leave`, {}, memberCookie)).statusCode,
    409,
    "a member's only workspace cannot be left",
  );
  const second = (await request("POST", "/api/workspaces", { name: "Segundo" })).json();
  assert.equal(
    (await request("POST", `/api/workspaces/${second.id}/leave`, {})).statusCode,
    409,
    "the last administrator cannot leave",
  );
  const invitation = await request("POST", `/api/workspaces/${second.id}/invitations`, {
    email: "spaces-member@example.test",
    role: "viewer",
  });
  assert.equal(invitation.statusCode, 200, invitation.body);
  const token = new URL(invitation.json().url).searchParams.get("invitation");
  const accepted = await request(
    "POST",
    "/api/invitations/accept",
    { token, email: "spaces-member@example.test", password: "invited-password-long", name: "spaces-member@example.test" },
    "",
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.ok((await list(memberCookie)).some((w: any) => w.id === second.id && w.role === "viewer"));
  const left = await request("POST", `/api/workspaces/${second.id}/leave`, {}, memberCookie);
  assert.equal((await list(memberCookie)).length >= 1, true);
  assert.equal(left.statusCode, 200, left.body);
  assert.ok(!(await list(memberCookie)).some((w: any) => w.id === second.id));
  assert.equal(
    (await request("GET", `/api/workspaces/${second.id}/resources`, undefined, memberCookie)).statusCode,
    403,
  );
});
test("hidden workspaces are a personal preference", async () => {
  const saved = await request("PUT", "/api/preferences", { hiddenWorkspaces: [workspaceId] });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await request("PUT", "/api/preferences", { hiddenWorkspaces: ["x"] })).statusCode, 400);
});
