import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import type { Resource } from "../shared/model";
import { gunzipSync } from "node:zlib";
import packageMetadata from "../package.json";

let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  ownerCookie: string,
  workspaceId: string,
  ownerId: string;
const headers = { "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1", origin: "http://test.local" };
test("health identifies the actual application package version", async () => {
  const response = await api.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().version, packageMetadata.version);
});
const request = async (
  method: any,
  url: string,
  payload?: any,
  cookie = ownerCookie,
) =>
  api.app.inject({
    method,
    url,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    payload,
  });
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
      email: "owner@example.test",
      password: "test-password-long-enough",
      name: "Owner",
      workspaceName: "Research team",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const session = (await request("GET", "/api/me")).json();
  workspaceId = session.workspaces[0].id;
  ownerId = session.user.id;
});
after(async () => {
  await api.app.close();
  await db.close();
});
async function mutate(
  kind: string,
  title: string,
  data: any = {},
  id = randomUUID(),
  version = 0,
  cookie = ownerCookie,
  operationId = randomUUID(),
) {
  return request(
    "POST",
    `/api/workspaces/${workspaceId}/mutate`,
    { id, operationId, kind, title, data, expectedVersion: version },
    cookie,
  );
}
async function invite(email: string, role: string) {
  const result = await request(
    "POST",
    `/api/workspaces/${workspaceId}/invitations`,
    { email, role },
  );
  assert.equal(result.statusCode, 200, result.body);
  const token = new URL(result.json().url).searchParams.get("invitation");
  const accepted = await request(
    "POST",
    "/api/invitations/accept",
    {
      email,
      role,
      name: email.split("@")[0],
      password: "invited-password-long",
      token,
    },
    "",
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  return accepted.headers["set-cookie"]!.toString().split(";")[0];
}
test("setup is protected and cannot be repeated", async () => {
  const response = await request("POST", "/api/setup", {
    email: "other@example.test",
    password: "another-password-long",
    name: "Other",
    workspaceName: "Other",
    setupToken: "test-setup-token",
  });
  assert.equal(response.statusCode, 409);
});
test("unauthenticated and cross-origin mutations are rejected", async () => {
  assert.equal(
    (
      await request(
        "GET",
        `/api/workspaces/${workspaceId}/resources`,
        undefined,
        "",
      )
    ).statusCode,
    401,
  );
  const response = await api.app.inject({
    method: "POST",
    url: "/api/logout",
    headers: { ...headers, cookie: ownerCookie, origin: "https://evil.test" },
    payload: {},
  });
  assert.equal(response.statusCode, 403);
  assert.equal(
    (
      await api.app.inject({
        method: "POST",
        url: "/api/logout",
        payload: {},
        headers: { cookie: ownerCookie },
      })
    ).statusCode,
    403,
  );
});
test("mutations are durable, idempotent and reject stale writes", async () => {
  const id = randomUUID(),
    operationId = randomUUID();
  const first = await mutate(
    "task",
    "Versioned task",
    { status: "todo" },
    id,
    0,
    ownerCookie,
    operationId,
  );
  assert.equal(first.statusCode, 200, first.body);
  const repeated = await mutate(
    "task",
    "Versioned task",
    { status: "todo" },
    id,
    0,
    ownerCookie,
    operationId,
  );
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().resource.version, 1);
  assert.equal(
    (await mutate("task", "Changed task", { status: "done" }, id, 1))
      .statusCode,
    200,
  );
  const conflict = await mutate(
    "task",
    "Stale overwrite",
    { status: "backlog" },
    id,
    1,
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().detail.current.title, "Changed task");
  const records = (
    await request("GET", `/api/workspaces/${workspaceId}/resources`)
  ).json().resources;
  assert.equal(
    records.find((r: Resource) => r.id === id).title,
    "Changed task",
  );
});
test("viewer cannot write and member cannot see a private project or its tasks", async () => {
  const viewer = await invite("viewer@example.test", "viewer");
  assert.equal(
    (await mutate("task", "Forbidden", {}, randomUUID(), 0, viewer)).statusCode,
    403,
  );
  const member = await invite("member@example.test", "member");
  const project = (
    await mutate("project", "Private project", { private: true, members: [] })
  ).json().resource;
  const task = (
    await mutate("task", "Private task", {
      projectId: project.id,
      status: "todo",
    })
  ).json().resource;
  const visible = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/resources`,
      undefined,
      member,
    )
  ).json().resources;
  assert.ok(
    !visible.some((r: Resource) => r.id === project.id || r.id === task.id),
  );
  assert.equal(
    (
      await mutate(
        "task",
        "Access bypass",
        { projectId: project.id },
        randomUUID(),
        0,
        member,
      )
    ).statusCode,
    403,
  );
  const exportResult = await request(
    "GET",
    `/api/workspaces/${workspaceId}/export`,
    undefined,
    member,
  );
  assert.ok(!exportResult.body.includes("Private task"));
});
test("cross-workspace references and private-note ownership cannot be forged", async () => {
  const other = (
    await request("POST", "/api/workspaces", { name: "Separate workspace" })
  ).json();
  const id = randomUUID();
  const response = await request("POST", `/api/workspaces/${other.id}/mutate`, {
    id,
    operationId: randomUUID(),
    kind: "project",
    title: "Other project",
    data: {},
    expectedVersion: 0,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    (await mutate("task", "Wrong workspace", { projectId: id })).statusCode,
    400,
  );
  assert.equal(
    (await mutate("document", "Forged note", { ownerId: randomUUID() }))
      .statusCode,
    403,
  );
});
test("sprint close preserves immutable snapshot and rolls unfinished tasks back to planning", async () => {
  const sprint = (
    await mutate("sprint", "Sprint one", {
      status: "active",
      goal: "Preserve history",
    })
  ).json().resource;
  const done = (
    await mutate("task", "Delivered", {
      status: "done",
      sprintId: sprint.id,
      estimate: 3,
    })
  ).json().resource;
  const pending = (
    await mutate("task", "Pending", {
      status: "in_progress",
      sprintId: sprint.id,
      estimate: 5,
    })
  ).json().resource;
  const closed = await request(
    "POST",
    `/api/workspaces/${workspaceId}/sprints/${sprint.id}/close`,
    { expectedVersion: sprint.version },
  );
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().resource.data.snapshot.length, 2);
  const records = (
    await request("GET", `/api/workspaces/${workspaceId}/resources`)
  ).json().resources;
  assert.equal(
    records.find((r: Resource) => r.id === pending.id).data.sprintId,
    null,
  );
  await mutate(
    "task",
    "Changed after closing",
    { ...done.data, estimate: 13 },
    done.id,
    1,
  );
  const snapshot = (
    await request("GET", `/api/workspaces/${workspaceId}/resources`)
  )
    .json()
    .resources.find((r: Resource) => r.id === sprint.id).data.snapshot;
  assert.equal(
    snapshot.find((r: Resource) => r.id === done.id).data.estimate,
    3,
  );
  assert.equal(
    (
      await mutate(
        "sprint",
        "Rewrite history",
        { status: "active" },
        sprint.id,
        2,
      )
    ).statusCode,
    409,
  );
});
test("last administrator cannot be removed", async () => {
  const result = await request(
    "PATCH",
    `/api/workspaces/${workspaceId}/members/${ownerId}`,
    { role: "member" },
  );
  assert.equal(result.statusCode, 409);
});
test("AI is opt-in and API credentials are never returned", async () => {
  const disabled = await request(
    "POST",
    `/api/workspaces/${workspaceId}/ai/generate`,
    { prompt: "Summarize", resourceIds: [] },
  );
  assert.equal(disabled.statusCode, 409);
  const result = await request(
    "PUT",
    `/api/workspaces/${workspaceId}/ai/settings`,
    {
      enabled: false,
      provider: "openai-compatible",
      model: "test-model",
      apiKey: "test-api-secret",
      monthlyRequestLimit: 5,
    },
  );
  assert.equal(result.statusCode, 200, result.body);
  const settings = await request(
    "GET",
    `/api/workspaces/${workspaceId}/ai/settings`,
  );
  assert.equal(settings.json().hasApiKey, true);
  assert.ok(!settings.body.includes("test-api-secret"));
  assert.ok(!settings.body.includes("encryptedApiKey"));
});
test("private target comments inherit visibility and parent cycles are rejected", async () => {
  const member = await invite("privacy-review@example.test", "member");
  const note = (
    await mutate("document", "Owner private note", { ownerId })
  ).json().resource;
  const comment = (
    await mutate("comment", "Private discussion", {
      targetId: note.id,
      description: "Private discussion body",
    })
  ).json().resource;
  const visible = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/resources`,
      undefined,
      member,
    )
  ).json().resources;
  assert.ok(
    !visible.some((r: Resource) => r.id === note.id || r.id === comment.id),
  );
  const a = (await mutate("document", "Parent A", {})).json().resource;
  const b = (await mutate("document", "Parent B", { parentId: a.id })).json()
    .resource;
  assert.ok(
    [400, 403].includes(
      (await mutate("document", "Parent A", { parentId: b.id }, a.id, 1))
        .statusCode,
    ),
  );
  const after = (
    await request("GET", `/api/workspaces/${workspaceId}/resources`)
  )
    .json()
    .resources.find((r: Resource) => r.id === a.id);
  assert.equal(after.version, 1);
  assert.equal(after.data.parentId, undefined);
  assert.equal(
    (await mutate("task", "Invalid workflow", { status: "invented" }))
      .statusCode,
    400,
  );
  assert.equal(
    (await mutate("project", "Invalid ownership", { ownerId })).statusCode,
    400,
  );
});
test("sprint snapshots and their historical versions respect current project visibility", async () => {
  const member = await invite("history-review@example.test", "member");
  const project = (
    await mutate("project", "Initially visible project", {})
  ).json().resource;
  const sprint = (
    await mutate("sprint", "Visibility sprint", { status: "active" })
  ).json().resource;
  const task = (
    await mutate("task", "Later confidential task", {
      projectId: project.id,
      sprintId: sprint.id,
      status: "done",
    })
  ).json().resource;
  assert.equal(
    (
      await request(
        "POST",
        `/api/workspaces/${workspaceId}/sprints/${sprint.id}/close`,
        { expectedVersion: 1 },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await mutate(
        "project",
        project.title,
        { private: true, members: [] },
        project.id,
        1,
      )
    ).statusCode,
    200,
  );
  const visible = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/resources`,
      undefined,
      member,
    )
  ).json().resources;
  assert.ok(
    !visible
      .find((r: Resource) => r.id === sprint.id)
      .data.snapshot.some((r: Resource) => r.id === task.id),
  );
  const history = await request(
    "GET",
    `/api/workspaces/${workspaceId}/resources/${sprint.id}/versions`,
    undefined,
    member,
  );
  assert.equal(history.statusCode, 200);
  assert.ok(!history.body.includes("Later confidential task"));
});
test("task relationships reject cycles and assignments notify read-only members", async () => {
  const members = (
    await request("GET", `/api/workspaces/${workspaceId}/resources`)
  ).json().members;
  const viewer = members.find((m: any) => m.email === "viewer@example.test");
  const a = (
    await mutate("task", "Dependency A", {
      status: "todo",
      assigneeId: viewer.id,
    })
  ).json().resource;
  const b = (
    await mutate("task", "Dependency B", {
      status: "todo",
      dependencies: [a.id],
    })
  ).json().resource;
  assert.equal(
    (
      await mutate(
        "task",
        "Dependency A",
        { status: "todo", dependencies: [b.id] },
        a.id,
        1,
      )
    ).statusCode,
    400,
  );
  const login = await request(
    "POST",
    "/api/login",
    { email: "viewer@example.test", password: "invited-password-long" },
    "",
  );
  const viewerCookie = login.headers["set-cookie"]!.toString().split(";")[0];
  const visible = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/resources`,
      undefined,
      viewerCookie,
    )
  ).json().resources;
  const notification = visible.find(
    (r: Resource) => r.kind === "notification" && r.data.targetId === a.id,
  );
  assert.ok(notification);
  assert.equal(
    (
      await mutate(
        "notification",
        notification.title,
        { ...notification.data, read: true },
        notification.id,
        notification.version,
        viewerCookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await mutate(
        "notification",
        "Forged message",
        { ...notification.data, read: true },
        notification.id,
        2,
        viewerCookie,
      )
    ).statusCode,
    403,
  );
});
test("attachments inherit permissions, use verified MIME and appear in the complete archive", async () => {
  const document = (
    await mutate("document", "Attachment fixture", { ownerId })
  ).json().resource;
  const bytes = Buffer.from('<svg onload="alert(1)"></svg>');
  const uploaded = await request(
    "POST",
    `/api/workspaces/${workspaceId}/resources/${document.id}/attachments`,
    {
      name: "untrusted.svg",
      mime: "image/svg+xml",
      base64: bytes.toString("base64"),
    },
  );
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.equal(uploaded.json().attachment.mime, "application/octet-stream");
  const url = uploaded.json().attachment.url;
  const file = await request("GET", url);
  assert.equal(file.statusCode, 200);
  assert.match(String(file.headers["content-disposition"]), /^attachment/);
  assert.deepEqual(file.rawPayload, bytes);
  const viewerLogin = await request(
    "POST",
    "/api/login",
    { email: "viewer@example.test", password: "invited-password-long" },
    "",
  );
  const viewerCookie =
    viewerLogin.headers["set-cookie"]!.toString().split(";")[0];
  assert.equal(
    (await request("GET", url, undefined, viewerCookie)).statusCode,
    404,
  );
  const archive = await request(
    "GET",
    `/api/workspaces/${workspaceId}/export/archive`,
  );
  assert.equal(archive.statusCode, 200, archive.body.slice(0, 100));
  const tar = gunzipSync(archive.rawPayload);
  let offset = 0;
  const entries = new Map<string, Buffer>();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(
      header.subarray(124, 136).toString().replace(/\0.*$/s, ""),
      8,
    );
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const manifest = JSON.parse(entries.get("workspace.json")!.toString());
  assert.equal(manifest.documentSchemaVersion, 1);
  assert.ok(
    manifest.attachments.some(
      (a: any) => a.id === uploaded.json().attachment.id,
    ),
  );
  assert.deepEqual(
    entries.get("attachments/" + uploaded.json().attachment.id),
    bytes,
  );
});
test("document content checkpoints are permission scoped and preserved independently of metadata versions", async () => {
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Checkpoint fixture" }],
      },
    ],
  };
  const document = (
    await mutate("document", "Checkpoint document", { content, ownerId })
  ).json().resource;
  const created = await request(
    "POST",
    `/api/workspaces/${workspaceId}/documents/${document.id}/revisions`,
    {},
  );
  assert.equal(created.statusCode, 200, created.body);
  const history = await request(
    "GET",
    `/api/workspaces/${workspaceId}/documents/${document.id}/revisions`,
  );
  assert.equal(history.statusCode, 200);
  assert.deepEqual(history.json().revisions[0].content, content);
  await mutate(
    "document",
    "Renamed checkpoint document",
    { content: { type: "doc", content: [] }, ownerId },
    document.id,
    1,
  );
  const previous = (
    await request(
      "GET",
      `/api/workspaces/${workspaceId}/documents/${document.id}/revisions`,
    )
  ).json().revisions[0];
  assert.deepEqual(previous.content, content);
});
