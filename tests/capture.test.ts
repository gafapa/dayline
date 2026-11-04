import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import * as Y from "yjs";
import { initialDocument } from "../shared/document-seed";
import {
  buildCapturedResource,
  captureDocument,
  captureDraftSchema,
  captureSourceUrl,
  type CaptureDraft,
} from "../shared/capture";
import { validateDocumentContent } from "../server/document-validation";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import type { Resource, User } from "../shared/model";
const user: User = {
    id: randomUUID(),
    email: "capture@example.test",
    name: "Capture author",
  },
  workspace = randomUUID();
const draft = (kind: CaptureDraft["kind"] = "private_note"): CaptureDraft => ({
  id: randomUUID(),
  kind,
  title: "Captured idea",
  text: "First paragraph\n\n<script>literal text</script>",
  sourceUrl: "https://example.test/research",
  destinationId: "",
  assignToMe: true,
  dueDate: "",
  customFields: {},
});
const resource = (
  kind: Resource["kind"],
  data: any = {},
  id = randomUUID(),
): Resource => ({
  id,
  kind,
  data,
  title: kind,
  workspace_id: workspace,
  version: 1,
  created_by: user.id,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
});

test("captured notes remain personal regardless of a selected shared destination and preserve literal text", () => {
  const project = resource("project"),
    input = { ...draft(), destinationId: project.id },
    captured = buildCapturedResource(input, user, workspace, [project]);
  assert.equal(captured.kind, "document");
  assert.equal(captured.data.personalNote, true);
  assert.equal(captured.data.ownerId, user.id);
  assert.equal(captured.data.projectId, undefined);
  assert.equal(captured.data.parentId, undefined);
  assert.equal(
    captured.data.content.content[2].content[0].text,
    "<script>literal text</script>",
  );
  validateDocumentContent(captured.data.content);
  assert.equal(captured.id, input.id);
});
test("document captures inherit their folder project and tasks preserve personal assignment and configured values", () => {
  const project = resource("project"),
    folder = resource("folder", { projectId: project.id }),
    all = [project, folder],
    document = buildCapturedResource(
      { ...draft("document"), destinationId: folder.id },
      user,
      workspace,
      all,
    );
  assert.equal(document.data.parentId, folder.id);
  assert.equal(document.data.projectId, project.id);
  assert.equal(document.data.ownerId, undefined);
  const task = buildCapturedResource(
    {
      ...draft("task"),
      destinationId: project.id,
      dueDate: "2026-12-03",
      customFields: { effort: 3 },
    },
    user,
    workspace,
    all,
  );
  assert.equal(task.data.assigneeId, user.id);
  assert.equal(task.data.status, "backlog");
  assert.equal(task.data.dueDate, "2026-12-03");
  assert.equal(task.data.customFields.effort, 3);
  assert.equal(task.data.content, undefined);
  assert.throws(
    () =>
      buildCapturedResource(
        { ...draft("task"), destinationId: folder.id },
        user,
        workspace,
        all,
      ),
    /ubicación/,
  );
  assert.throws(
    () =>
      buildCapturedResource(
        { ...draft("document"), destinationId: folder.id },
        user,
        randomUUID(),
        all,
      ),
    /ubicación/,
  );
});
test("capture rejects active or credential-bearing source URLs and excessive input without fetching remote content", () => {
  for (const source of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///private",
    "https://name:secret@example.test",
    "https://exam\nple.test",
  ])
    assert.throws(() => captureSourceUrl(source));
  assert.equal(
    captureSourceUrl(" https://example.test "),
    "https://example.test/",
  );
  assert.throws(() => captureDocument("text", "javascript:alert(1)"));
  assert.equal(
    captureDraftSchema.safeParse({ ...draft(), text: "\n".repeat(5001) })
      .success,
    false,
  );
  assert.throws(
    () =>
      buildCapturedResource(
        { ...draft("task"), dueDate: "2026-02-30" },
        user,
        workspace,
        [],
      ),
    /fecha/,
  );
  assert.throws(
    () =>
      buildCapturedResource({ ...draft(), title: "   " }, user, workspace, []),
    /título/,
  );
});

let db: Database,
  app: Awaited<ReturnType<typeof createApp>>,
  owner: string,
  peer: string,
  ownerId: string,
  ws: string;
const headers = {
  origin: "http://capture.test",
  "x-kelvin-client": "web",
  "x-kelvin-document-schema": "1",
};
const call = (method: any, path: string, payload?: any, cookie = owner) =>
  app.app.inject({
    method,
    url: path.startsWith("/api") ? path : `/api/workspaces/${ws}${path}`,
    payload,
    headers: { ...headers, cookie },
  });
const mutate = async (record: Resource, cookie = owner) =>
  call(
    "POST",
    "/mutate",
    {
      operationId: randomUUID(),
      id: record.id,
      kind: record.kind,
      title: record.title,
      data: record.data,
      expectedVersion: 0,
    },
    cookie,
  );
before(async () => {
  db = await createDatabase("", "memory://");
  await migrate(db);
  app = await createApp(db, {
    origin: headers.origin,
    setupToken: "capture-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await call(
    "POST",
    "/api/setup",
    {
      email: "capture-owner@example.test",
      name: "Capture owner",
      password: "capture-password-long",
      workspaceName: "Capture tests",
      setupToken: "capture-setup",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  owner = String(setup.headers["set-cookie"]).split(";")[0];
  const profile = (await call("GET", "/api/me")).json();
  ownerId = profile.user.id;
  ws = profile.workspaces[0].id;
  const invitation = await call("POST", "/invitations", {
    email: "capture-peer@example.test",
    role: "admin",
  });
  const accepted = await call(
    "POST",
    "/api/invitations/accept",
    {
      email: "capture-peer@example.test",
      name: "Other administrator",
      password: "capture-password-long",
      token: new URL(invitation.json().url).searchParams.get("invitation"),
    },
    "",
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  peer = String(accepted.headers["set-cookie"]).split(";")[0];
});
after(async () => {
  await app.app.close();
  await db.close();
});

test("initial document seed version one has immutable canonical bytes", () => {
  const body = captureDocument(
    "Seed contract\nSecond paragraph",
    "https://example.invalid/seed",
  );
  const seeded = initialDocument(body, "11111111-1111-4111-8111-111111111111");
  try {
    assert.equal(
      createHash("sha256").update(Y.encodeStateAsUpdate(seeded)).digest("hex"),
      "ccd010b1cad2e46cf749547eb138058403a5588ea1cba9ee6d57e0df54a83644",
    );
  } finally {
    seeded.destroy();
  }
});
test("atomic captured state merges with offline edits without duplicate initial paragraphs", async () => {
  const captured = buildCapturedResource(
      draft(),
      { ...user, id: ownerId },
      ws,
      [],
    ),
    created = await mutate(captured);
  assert.equal(created.statusCode, 200, created.body);
  const stored = (
    await db.query("SELECT state FROM document_states WHERE resource_id=$1", [
      captured.id,
    ])
  ).rows[0]?.state;
  assert.ok(stored);
  const seed = initialDocument(captured.data.content, captured.id),
    local = new Y.Doc();
  try {
    assert.deepEqual(
      Buffer.from(stored),
      Buffer.from(Y.encodeStateAsUpdate(seed)),
    );
    Y.applyUpdate(local, Y.encodeStateAsUpdate(seed));
    const paragraph = local.getXmlFragment("default").get(0) as Y.XmlElement,
      text = paragraph.get(0) as Y.XmlText;
    text.insert(text.length, " edited offline");
    Y.applyUpdate(local, Buffer.from(stored));
    Y.applyUpdate(local, Buffer.from(stored));
    assert.equal(local.getXmlFragment("default").length,captured.data.content.content.length);
    assert.equal(text.toString(),"First paragraph edited offline");
  } finally {
    seed.destroy();
    local.destroy();
  }
});
test("initial seed markers are document-only, immutable and cannot retrofit an existing document", async () => {
  const captured = buildCapturedResource(
      draft(),
      { ...user, id: ownerId },
      ws,
      [],
    ),
    created = await mutate(captured);
  assert.equal(created.statusCode, 200);
  const data = { ...captured.data };
  delete data.documentSeedVersion;
  assert.equal(
    (
      await call("POST", "/mutate", {
        operationId: randomUUID(),
        id: captured.id,
        kind: "document",
        title: captured.title,
        data,
        expectedVersion: 1,
      })
    ).statusCode,
    409,
  );
  const ordinary = buildCapturedResource(
    draft("document"),
    { ...user, id: ownerId },
    ws,
    [],
  );
  delete ordinary.data.documentSeedVersion;
  assert.equal((await mutate(ordinary)).statusCode, 200);
  assert.equal(
    (
      await call("POST", "/mutate", {
        operationId: randomUUID(),
        id: ordinary.id,
        kind: "document",
        title: ordinary.title,
        data: { ...ordinary.data, documentSeedVersion: 1 },
        expectedVersion: 1,
      })
    ).statusCode,
    409,
  );
  const task = buildCapturedResource(
    draft("task"),
    { ...user, id: ownerId },
    ws,
    [],
  );
  task.data.documentSeedVersion = 1;
  assert.equal((await mutate(task)).statusCode, 400);
});
test("missing canonical state is reported without fabricating a different initial history", async () => {
  const captured = buildCapturedResource(
    draft(),
    { ...user, id: ownerId },
    ws,
    [],
  );
  assert.equal((await mutate(captured)).statusCode, 200);
  const state = (
    await db.query("SELECT state FROM document_states WHERE resource_id=$1", [
      captured.id,
    ])
  ).rows[0].state;
  await db.query("DELETE FROM document_states WHERE resource_id=$1", [
    captured.id,
  ]);
  const response = await call("GET", `/documents/${captured.id}/state`);
  assert.equal(response.statusCode, 409);
  assert.equal(
    response.json().detail.code,
    "initial_document_state_unavailable",
  );
  assert.equal(
    (
      await db.query("SELECT state FROM document_states WHERE resource_id=$1", [
        captured.id,
      ])
    ).rows.length,
    0,
  );
  await db.query(
    "INSERT INTO document_states(resource_id,state) VALUES($1,$2)",
    [captured.id, state],
  );
});
test("captured document bodies survive API creation while notes stay hidden from another administrator", async () => {
  const author = { ...user, id: ownerId };
  const captured = buildCapturedResource(draft(), author, ws, []),
    created = await mutate(captured);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(
    created.json().resource.data.content.content[0].content[0].text,
    "First paragraph",
  );
  assert.equal(
    (await call("GET", "/resources", undefined, peer))
      .json()
      .resources.some((item: Resource) => item.id === captured.id),
    false,
  );
  assert.equal(
    (await call("GET", `/documents/${captured.id}/state`, undefined, peer))
      .statusCode,
    404,
  );
  const shared = buildCapturedResource(draft("document"), author, ws, []),
    sharedResult = await mutate(shared);
  assert.equal(sharedResult.statusCode, 200, sharedResult.body);
  assert.equal(
    (await call("GET", "/resources", undefined, peer))
      .json()
      .resources.some((item: Resource) => item.id === shared.id),
    true,
  );
});
test("task capture uses server field validation and current workspace permissions", async () => {
  const fieldId = randomUUID(),
    project = resource("project", {
      fieldDefinitions: [
        {
          id: fieldId,
          name: "Effort",
          type: "number",
          required: true,
          archived: false,
          options: [],
          defaultValue: 3,
        },
      ],
    });
  project.workspace_id = ws;
  project.created_by = ownerId;
  const created = await mutate(project);
  assert.equal(created.statusCode, 200, created.body);
  const current = created.json().resource;
  const task = buildCapturedResource(
    {
      ...draft("task"),
      destinationId: current.id,
      customFields: { [fieldId]: 8 },
    },
    { ...user, id: ownerId },
    ws,
    [current],
  );
  const accepted = await mutate(task);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().resource.data.customFields[fieldId], 8);
  const forged = {
    ...task,
    id: randomUUID(),
    data: { ...task.data, customFields: { [fieldId]: "wrong" } },
  };
  assert.equal((await mutate(forged)).statusCode, 400);
  const second = (
    await call("POST", "/api/workspaces", {
      name: "Separate capture workspace",
    })
  ).json();
  const wrong = await app.app.inject({
    method: "POST",
    url: `/api/workspaces/${second.id}/mutate`,
    payload: {
      operationId: randomUUID(),
      id: randomUUID(),
      kind: task.kind,
      title: task.title,
      data: task.data,
      expectedVersion: 0,
    },
    headers: { ...headers, cookie: owner },
  });
  assert.equal(wrong.statusCode, 400);
});
