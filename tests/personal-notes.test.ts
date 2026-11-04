import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { canRead } from "../server/permissions";
import { isStructure } from "../shared/hierarchy";
import type { Resource } from "../shared/model";

let db: Database,
  app: Awaited<ReturnType<typeof createApp>>,
  ws: string,
  owner: string,
  ownerId: string,
  administrator: string,
  member: string;
const headers = {
  origin: "http://notes.test",
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
const input = (
  kind: string,
  data: any = {},
  id: string = randomUUID(),
  version = 0,
) => ({
  operationId: randomUUID(),
  id,
  kind,
  title: "Personal note test",
  data,
  expectedVersion: version,
});
async function create(kind: string, data: any = {}) {
  const body = input(kind, data),
    result = await call("POST", "/mutate", body);
  assert.equal(result.statusCode, 200, result.body);
  return { resource: result.json().resource as Resource, body };
}
const edit = (resource: Resource, patch: any, cookie = owner) =>
  call(
    "POST",
    "/mutate",
    input(
      resource.kind,
      { ...resource.data, ...patch },
      resource.id,
      resource.version,
    ),
    cookie,
  );
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  app = await createApp(db, {
    origin: "http://notes.test",
    setupToken: "notes-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await call(
    "POST",
    "/api/setup",
    {
      email: "notes-owner@example.test",
      name: "Note author",
      password: "notes-password-long",
      workspaceName: "Notes tests",
      setupToken: "notes-setup",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  owner = String(setup.headers["set-cookie"]).split(";")[0];
  const me = (await call("GET", "/api/me")).json();
  ws = me.workspaces[0].id;
  ownerId = me.user.id;
  for (const role of ["admin", "member"]) {
    const email = `notes-${role}@example.test`,
      invitation = await call("POST", "/invitations", { email, role });
    assert.equal(invitation.statusCode, 200, invitation.body);
    const accepted = await call(
      "POST",
      "/api/invitations/accept",
      {
        email,
        name: role,
        password: "notes-password-long",
        token: new URL(invitation.json().url).searchParams.get("invitation"),
      },
      "",
    );
    assert.equal(accepted.statusCode, 200, accepted.body);
    const cookie = String(accepted.headers["set-cookie"]).split(";")[0];
    if (role === "admin") administrator = cookie;
    else member = cookie;
  }
});
after(async () => {
  await app.app.close();
  await db.close();
});
test("personal notes acquire their author and remain absent from other members and administrators", async () => {
  const { resource, body } = await create("document", {
    personalNote: true,
    description: "Private summary",
  });
  assert.equal(resource.data.ownerId, ownerId);
  assert.equal(isStructure(resource), false);
  for (const cookie of [administrator, member]) {
    assert.equal(
      (await call("GET", "/resources", undefined, cookie))
        .json()
        .resources.some((item: Resource) => item.id === resource.id),
      false,
    );
    assert.equal(
      (
        await call(
          "GET",
          `/api/resources/${resource.id}/location`,
          undefined,
          cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await call(
          "GET",
          `/resources/${resource.id}/versions`,
          undefined,
          cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await call("GET", `/documents/${resource.id}/state`, undefined, cookie))
        .statusCode,
      404,
    );
    assert.equal(
      (await edit(resource, { description: "Forbidden" }, cookie)).statusCode,
      403,
    );
  }
  assert.equal(
    (await call("POST", "/mutate", body)).json().resource.version,
    1,
  );
});
test("privacy and classification cannot be removed, relocated, forged or retrofitted onto a shared page", async () => {
  const note = (await create("document", { personalNote: true })).resource,
    project = (await create("project")).resource;
  for (const patch of [
    { personalNote: false },
    { ownerId: undefined },
    { ownerId: randomUUID() },
  ])
    assert.equal((await edit(note, patch)).statusCode, 403);
  assert.equal((await edit(note, { projectId: project.id })).statusCode, 400);
  assert.equal(
    (await call("POST", "/mutate", input("task", { personalNote: true })))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/mutate",
        input("document", { personalNote: true, ownerId: randomUUID() }),
      )
    ).statusCode,
    403,
  );
  const shared = (await create("document")).resource;
  assert.equal(
    (await edit(shared, { personalNote: true, ownerId: ownerId })).statusCode,
    400,
  );
  assert.equal(
    (await call("POST", "/mutate", input("document", { parentId: note.id })))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", "/hierarchy/preview", {
        id: note.id,
        destinationId: project.id,
      })
    ).statusCode,
    404,
  );
});
test("normal metadata, archive, trash and restore preserve the personal owner and history", async () => {
  let note = (await create("document", { personalNote: true })).resource;
  const changed = await edit(note, { description: "Revised", archived: true });
  assert.equal(changed.statusCode, 200, changed.body);
  note = changed.json().resource;
  const remove = await call("POST", "/mutate", {
    ...input("document", note.data, note.id, note.version),
    deleted: true,
  });
  assert.equal(remove.statusCode, 200, remove.body);
  note = remove.json().resource;
  const restore = await call("POST", "/mutate", {
    ...input("document", note.data, note.id, note.version),
    deleted: false,
  });
  assert.equal(restore.statusCode, 200, restore.body);
  note = restore.json().resource;
  assert.equal(note.data.ownerId, ownerId);
  assert.equal(note.data.personalNote, true);
  const versions = (await call("GET", `/resources/${note.id}/versions`)).json()
    .versions;
  assert.equal(versions.length, 4);
  assert.ok(
    versions.every(
      (version: any) =>
        version.snapshot.data.ownerId === ownerId &&
        version.snapshot.data.personalNote,
    ),
  );
});
test("captured note templates copy as private notes even when workspace visibility is requested", async () => {
  const note = (
    await create("document", {
      personalNote: true,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "A private thought" }],
          },
        ],
      },
    })
  ).resource;
  const captured = await call("POST", "/templates/capture", {
    operationId: randomUUID(),
    sourceId: note.id,
    expectedVersion: note.version,
    title: "Personal note template",
    anchorDate: "2026-11-03",
    shared: true,
  });
  assert.equal(captured.statusCode, 200, captured.body);
  const template = (await call("GET", "/resources"))
    .json()
    .resources.find((item: Resource) => item.id === captured.json().templateId);
  assert.equal(
    template.data.templateBlueprint.nodes[0].data.personalNote,
    true,
  );
  assert.equal(
    (await call("GET", "/resources", undefined, member))
      .json()
      .resources.some((item: Resource) => item.id === template.id),
    false,
  );
  const applied = await call("POST", `/templates/${template.id}/apply`, {
    operationId: randomUUID(),
    expectedVersion: template.version,
    title: "Private note copy",
    baseDate: "2026-11-03",
    visibility: "workspace",
  });
  assert.equal(applied.statusCode, 200, applied.body);
  const copied = (await call("GET", "/resources"))
    .json()
    .resources.find((item: Resource) => item.title === "Private note copy");
  assert.ok(copied);
  assert.equal(copied.data.ownerId, ownerId);
  assert.equal(copied.data.personalNote, true);
});

test("private note mentions and activity do not expose the note to other administrators", async () => {
  const note = (await create("document", { personalNote: true })).resource;
  const comment = (
    await create("comment", {
      targetId: note.id,
      description: "@notes-admin@example.test this remains private",
    })
  ).resource;
  const snapshot = (
    await call("GET", "/resources", undefined, administrator)
  ).json().resources;
  assert.equal(
    snapshot.some(
      (resource: Resource) =>
        resource.id === note.id ||
        resource.id === comment.id ||
        resource.data.targetId === note.id,
    ),
    false,
  );
  const activity = (
    await call("GET", "/activity", undefined, administrator)
  ).json().activity;
  assert.equal(
    activity.some(
      (event: any) =>
        event.resource_id === note.id || event.resource_id === comment.id,
    ),
    false,
  );
});

test("the personal marker still protects the author when a stored owner field is missing", async () => {
  const note = (await create("document", { personalNote: true })).resource;
  const legacy = { ...note, data: { ...note.data, ownerId: undefined } };
  assert.equal(canRead(legacy, randomUUID(), "admin", [legacy]), false);
  assert.equal(canRead(legacy, ownerId, "admin", [legacy]), true);
});
