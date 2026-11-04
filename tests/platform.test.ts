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
      email: "platform-owner@example.test",
      password: "test-password-long-enough",
      name: "Platform owner",
      workspaceName: "Platform tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
  const member = await invite("platform-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerId = (await invite("platform-viewer@example.test", "viewer")).id;
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

const login = (email: string, password: string) =>
  request("POST", "/api/login", { email, password }, "");
const cookieOf = (response: any) =>
  response.headers["set-cookie"]!.toString().split(";")[0];
const platform = (path: string, payload: any = {}, cookie = ownerCookie) =>
  request("POST", `/api/platform/users/${path}`, payload, cookie);
test("only platform administrators see the account list with workspaces, MFA and sessions", async () => {
  assert.equal((await request("GET", "/api/me")).json().user.platformAdmin, true);
  assert.equal((await request("GET", "/api/me", undefined, memberCookie)).json().user.platformAdmin, false);
  assert.equal((await request("GET", "/api/platform/users", undefined, memberCookie)).statusCode, 403);
  const listed = await request("GET", "/api/platform/users");
  assert.equal(listed.statusCode, 200, listed.body);
  const member = listed.json().users.find((u: any) => u.id === memberId);
  assert.equal(member.email, "platform-member@example.test");
  assert.equal(member.mfa_enabled, false);
  assert.ok(member.session_count >= 1);
  assert.ok(member.last_login_at);
  assert.deepEqual(member.workspaces.map((w: any) => w.role), ["member"]);
  const searched = (await request("GET", "/api/platform/users?q=VIEWER")).json().users;
  assert.deepEqual(searched.map((u: any) => u.id), [viewerId]);
});
test("suspension closes sessions, blocks login and stops the author's automations until reactivated", async () => {
  const project = await make("project", "Suspended rules");
  const rule = await make(
    "automation",
    "Member rule",
    { projectId: project.id, enabled: true, trigger: "task_created", action: "set_status", actionValue: "review" },
    memberCookie,
  );
  assert.equal((await platform(`${ownerId}/suspend`)).statusCode, 409, "cannot suspend yourself");
  const suspended = await platform(`${memberId}/suspend`);
  assert.equal(suspended.statusCode, 200, suspended.body);
  assert.ok(suspended.json().sessionsClosed >= 1);
  assert.equal((await request("GET", "/api/me", undefined, memberCookie)).statusCode, 401);
  const refused = await login("platform-member@example.test", "invited-password-long");
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().detail.code, "account_suspended");
  assert.equal((await login("platform-member@example.test", "wrong-password-long")).statusCode, 401);
  const task = await make("task", "Created while suspended", { projectId: project.id, status: "todo" });
  await api.automations.tick(new Date(), workspaceId);
  assert.equal((await current(task.id)).data.status, "todo");
  const run = (await db.query("SELECT * FROM automation_runs WHERE rule_id=$1", [rule.id])).rows[0];
  assert.equal(run.result.reason, "permissions_changed");
  assert.equal((await platform(`${memberId}/suspend`)).statusCode, 409);
  assert.equal((await platform(`${memberId}/reactivate`)).statusCode, 200);
  const back = await login("platform-member@example.test", "invited-password-long");
  assert.equal(back.statusCode, 200, back.body);
  memberCookie = cookieOf(back);
});
test("session revocation and MFA reset close every session of the account", async () => {
  await db.query("UPDATE app_users SET mfa_secret='encrypted-placeholder', recovery_hashes='[\"x\"]' WHERE id=$1", [viewerId]);
  const reset = await platform(`${viewerId}/mfa/reset`);
  assert.equal(reset.statusCode, 200, reset.body);
  const row = (await db.query("SELECT mfa_secret, recovery_hashes FROM app_users WHERE id=$1", [viewerId])).rows[0];
  assert.equal(row.mfa_secret, null);
  assert.deepEqual(row.recovery_hashes, []);
  const revoked = await platform(`${memberId}/sessions/revoke`);
  assert.equal(revoked.statusCode, 200);
  assert.equal((await request("GET", "/api/me", undefined, memberCookie)).statusCode, 401);
  memberCookie = cookieOf(await login("platform-member@example.test", "invited-password-long"));
});
test("password reset links are single use, replace older links and close sessions", async () => {
  const first = await platform(`${memberId}/password-reset`);
  assert.equal(first.statusCode, 200, first.body);
  const second = await platform(`${memberId}/password-reset`);
  const tokenOf = (r: any) => new URL(r.json().url).searchParams.get("reset");
  assert.equal(
    (await request("POST", "/api/account/reset", { token: tokenOf(first), newPassword: "NuevaClave1" }, "")).statusCode,
    400,
    "an older link is invalidated",
  );
  assert.equal(
    (await request("POST", "/api/account/reset", { token: tokenOf(second), newPassword: "corta" }, "")).statusCode,
    400,
  );
  const used = await request("POST", "/api/account/reset", { token: tokenOf(second), newPassword: "NuevaClave1" }, "");
  assert.equal(used.statusCode, 200, used.body);
  assert.equal((await request("GET", "/api/me", undefined, memberCookie)).statusCode, 401);
  assert.equal((await login("platform-member@example.test", "invited-password-long")).statusCode, 401);
  const fresh = await login("platform-member@example.test", "NuevaClave1");
  assert.equal(fresh.statusCode, 200);
  memberCookie = cookieOf(fresh);
  assert.equal(
    (await request("POST", "/api/account/reset", { token: tokenOf(second), newPassword: "OtraClave22" }, "")).statusCode,
    400,
    "a link works once",
  );
});
test("platform administrator role keeps one active administrator and actions are audited", async () => {
  assert.equal((await platform(`${ownerId}/platform-admin`, { platformAdmin: false })).statusCode, 409);
  assert.equal((await platform(`${memberId}/platform-admin`, { platformAdmin: true })).statusCode, 200);
  assert.equal((await request("GET", "/api/platform/users", undefined, memberCookie)).statusCode, 200);
  assert.equal(
    (await platform(`${memberId}/platform-admin`, { platformAdmin: false }, memberCookie)).statusCode,
    409,
    "administrators cannot remove their own access",
  );
  assert.equal((await platform(`${memberId}/platform-admin`, { platformAdmin: false })).statusCode, 200);
  assert.equal((await request("GET", "/api/platform/users", undefined, memberCookie)).statusCode, 403);
  const entries = (await request("GET", "/api/platform/audit?limit=100")).json().entries;
  const actions = entries.map((e: any) => e.action);
  for (const action of ["suspend", "reactivate", "revoke_sessions", "reset_mfa", "create_password_reset", "complete_password_reset", "set_platform_admin"])
    assert.ok(actions.includes(action), action);
  assert.ok(!JSON.stringify(entries).includes("reset="), "audit never stores reset links");
  assert.equal((await request("GET", "/api/platform/audit", undefined, memberCookie)).statusCode, 403);
});
