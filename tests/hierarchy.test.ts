import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { documentState } from "../server/document-state";
import { documentText } from "../shared/documents";
import { structurePath, projectAt } from "../shared/hierarchy";
import type { Resource } from "../shared/model";
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  ownerId: string,
  ownerCookie: string,
  memberCookie: string,
  memberId: string,
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
    url: path.startsWith("/api")
      ? path
      : `/api/workspaces/${workspaceId}${path}`,
    payload,
    headers: { ...headers, cookie },
  });
async function make(
  kind: string,
  title: string,
  data: any = {},
  cookie = ownerCookie,
) {
  const result = await request(
    "POST",
    "/mutate",
    {
      operationId: randomUUID(),
      id: randomUUID(),
      kind,
      title,
      data,
      expectedVersion: 0,
    },
    cookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  return result.json().resource as Resource;
}
async function edit(r: Resource, patch: any, cookie = ownerCookie) {
  return request(
    "POST",
    "/mutate",
    {
      operationId: randomUUID(),
      id: r.id,
      kind: r.kind,
      title: r.title,
      data: { ...r.data, ...patch },
      expectedVersion: r.version,
    },
    cookie,
  );
}
const get = async (id: string) =>
  (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id]))
    .rows[0];
const preview = async (
  id: string,
  destinationId: string | null,
  cookie = ownerCookie,
) => {
  const result = await request(
    "POST",
    "/hierarchy/preview",
    { id, destinationId },
    cookie,
  );
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
};
const move = (plan: any, operationId = randomUUID(), cookie = ownerCookie) =>
  request(
    "POST",
    "/hierarchy/move",
    {
      id: plan.id,
      destinationId: plan.destinationId,
      fingerprint: plan.fingerprint,
      operationId,
    },
    cookie,
  );
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, {
    origin: "http://test.local",
    setupToken: "hierarchy-test-setup",
    encryptionKey: "ab".repeat(32),
  });
  const result = await request(
    "POST",
    "/api/setup",
    {
      email: "hierarchy-owner@example.test",
      name: "Owner",
      password: "hierarchy-password-long",
      workspaceName: "Hierarchy tests",
      setupToken: "hierarchy-test-setup",
    },
    "",
  );
  assert.equal(result.statusCode, 200, result.body);
  ownerCookie = result.headers["set-cookie"]!.toString().split(";")[0];
  const profile = (await request("GET", "/api/me")).json();
  workspaceId = profile.workspaces[0].id;
  ownerId = profile.user.id;
  for (const role of ["member", "viewer"]) {
    const email = `hierarchy-${role}@example.test`,
      invite = await request("POST", "/invitations", { email, role });
    assert.equal(invite.statusCode, 200, invite.body);
    const accepted = await request(
      "POST",
      "/api/invitations/accept",
      {
        email,
        name: role,
        password: "hierarchy-password-long",
        token: new URL(invite.json().url).searchParams.get("invitation"),
      },
      "",
    );
    assert.equal(accepted.statusCode, 200, accepted.body);
    const cookie = accepted.headers["set-cookie"]!.toString().split(";")[0];
    if (role === "member") {
      memberCookie = cookie;
      memberId = (await request("GET", "/api/me", undefined, cookie)).json()
        .user.id;
    } else viewerCookie = cookie;
  }
});
after(async () => {
  await api.app.close();
  await db.close();
});
async function branch() {
  const a = await make("project", "Origin"),
    b = await make("project", "Destination"),
    folder = await make("folder", "Specifications", {
      parentId: a.id,
      projectId: a.id,
    }),
    doc = await make("document", "Overview", {
      parentId: folder.id,
      projectId: a.id,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Canonical content" }],
          },
        ],
      },
    }),
    child = await make("document", "Details", {
      parentId: doc.id,
      projectId: a.id,
    });
  return { a, b, folder, doc, child };
}

test("folder moves atomically reassign descendant documents and preserve canonical Yjs state", async () => {
  const f = await branch(),
    state = await documentState(db, f.doc.id),
    plan = await preview(f.folder.id, f.b.id);
  assert.equal(plan.affectedCount, 3);
  assert.equal(plan.changes.length, 3);
  const response = await move(plan);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await get(f.folder.id)).data.parentId, f.b.id);
  for (const original of [f.folder, f.doc, f.child]) {
    const current = await get(original.id);
    assert.equal(current.data.projectId, f.b.id);
    assert.equal(current.version, original.version + 1);
  }
  assert.equal(
    documentText((await get(f.doc.id)).data.content),
    "Canonical content",
  );
  assert.deepEqual(await documentState(db, f.doc.id), state);
  const history = (
    await db.query(
      "SELECT snapshot FROM resource_versions WHERE resource_id=$1 AND version=1",
      [f.doc.id],
    )
  ).rows[0].snapshot;
  assert.equal(history.data.projectId, f.a.id);
});

test("raw metadata moves cannot bypass complete subtree confirmation and typed parent rules", async () => {
  const f = await branch();
  assert.equal(
    (await edit(f.folder, { parentId: f.b.id, projectId: f.b.id })).statusCode,
    409,
  );
  assert.equal(
    (await make("task", "A task", { projectId: f.a.id })).kind,
    "task",
  );
  const bad = await request("POST", "/mutate", {
    operationId: randomUUID(),
    id: randomUUID(),
    kind: "folder",
    title: "Wrong scope",
    data: { parentId: f.a.id, projectId: f.b.id },
    expectedVersion: 0,
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(
    (
      await request("POST", "/hierarchy/preview", {
        id: f.folder.id,
        destinationId: f.child.id,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request("POST", "/hierarchy/preview", {
        id: f.doc.id,
        destinationId: f.child.id,
      })
    ).statusCode,
    400,
  );
  assert.equal((await edit(f.a, { parentId: f.folder.id })).statusCode, 400);
});

test("a private ancestor protects public subprojects and all their referenced resources", async () => {
  const parent = await make("project", "Restricted parent", {
      private: true,
      members: [],
    }),
    sub = await make("project", "Public child", { parentId: parent.id }),
    task = await make("task", "Inherited private task", { projectId: sub.id }),
    doc = await make("document", "Inherited private document", {
      projectId: sub.id,
    });
  const visible = (
    await request("GET", "/resources", undefined, memberCookie)
  ).json().resources;
  for (const r of [parent, sub, task, doc])
    assert.equal(
      visible.some((v: Resource) => v.id === r.id),
      false,
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
  const changed = await edit(parent, { members: [memberId] });
  assert.equal(changed.statusCode, 200, changed.body);
  const granted = (
    await request("GET", "/resources", undefined, memberCookie)
  ).json().resources;
  for (const r of [parent, sub, task, doc])
    assert.equal(
      granted.some((v: Resource) => v.id === r.id),
      true,
    );
});

test("preview fingerprints reject edited descendants, newly added children and changed destinations", async () => {
  const f = await branch();
  let plan = await preview(f.folder.id, f.b.id);
  assert.equal(
    (await edit(f.child, { description: "Changed after preview" })).statusCode,
    200,
  );
  assert.equal((await move(plan)).statusCode, 409);
  assert.equal((await get(f.folder.id)).version, 1);
  plan = await preview(f.folder.id, f.b.id);
  await make("document", "New child", {
    parentId: f.folder.id,
    projectId: f.a.id,
  });
  assert.equal((await move(plan)).statusCode, 409);
  plan = await preview(f.folder.id, f.b.id);
  assert.equal(
    (await edit(f.b, { description: "Destination changed" })).statusCode,
    200,
  );
  assert.equal((await move(plan)).statusCode, 409);
});

test("concurrent moves have one winner and a lost response can be retried without duplicate versions", async () => {
  const f = await branch(),
    other = await make("folder", "Other destination"),
    first = await preview(f.folder.id, f.b.id),
    second = await preview(f.folder.id, other.id),
    operationId = randomUUID();
  const responses = await Promise.all([move(first, operationId), move(second)]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const winner = responses[0].statusCode === 200 ? first : second;
  if (winner === first) {
    const replay = await move(first, operationId);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((await get(f.folder.id)).version, 2);
    assert.equal(
      (await move({ ...first, destinationId: other.id }, operationId))
        .statusCode,
      409,
    );
  }
});

test("hidden descendants, forbidden destinations, cross-workspace targets and viewers fail closed", async () => {
  const a = await make("project", "Team project"),
    b = await make("project", "Restricted destination", {
      private: true,
      members: [],
    }),
    folder = await make("folder", "Team folder", {
      parentId: a.id,
      projectId: a.id,
    });
  await make(
    "document",
    "Another personal note",
    { parentId: folder.id, projectId: a.id, ownerId: memberId },
    memberCookie,
  );
  assert.equal(
    (
      await request("POST", "/hierarchy/preview", {
        id: folder.id,
        destinationId: null,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/hierarchy/preview",
        { id: folder.id, destinationId: b.id },
        memberCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/hierarchy/preview",
        { id: folder.id, destinationId: null },
        viewerCookie,
      )
    ).statusCode,
    403,
  );
  const other = (
    await request("POST", "/api/workspaces", { name: "Separate scope" })
  ).json();
  const foreign = (
    await request("POST", `/api/workspaces/${other.id}/mutate`, {
      operationId: randomUUID(),
      id: randomUUID(),
      kind: "folder",
      title: "Foreign folder",
      data: {},
      expectedVersion: 0,
    })
  ).json().resource;
  assert.equal(
    (
      await request("POST", "/hierarchy/preview", {
        id: a.id,
        destinationId: foreign.id,
      })
    ).statusCode,
    404,
  );
});

test("late validation failure rolls back every earlier change and its command receipt", async () => {
  const f = await branch(),
    sprint = await make("sprint", "Frozen child", {
      parentId: f.folder.id,
      projectId: f.a.id,
      status: "active",
    });
  await db.query(
    "UPDATE resources SET data=jsonb_set(data,'{status}','\"completed\"') WHERE id=$1",
    [sprint.id],
  );
  const plan = await preview(f.folder.id, f.b.id),
    operationId = randomUUID(),
    result = await move(plan, operationId);
  assert.equal(result.statusCode, 409, result.body);
  for (const original of [f.folder, f.doc, f.child, sprint]) {
    const current = await get(original.id);
    assert.equal(current.version, 1);
    assert.equal(current.data.projectId, f.a.id);
  }
  assert.equal(
    (await db.query("SELECT id FROM operations WHERE id=$1", [operationId]))
      .rows.length,
    0,
  );
});

test("capturing a project preserves folder hierarchy and applying it remaps nested project scopes", async () => {
  const f = await branch(),
    sub = await make("project", "Nested project", { parentId: f.folder.id }),
    nestedFolder = await make("folder", "Nested project folder", {
      parentId: sub.id,
      projectId: sub.id,
    }),
    nestedDoc = await make("document", "Nested project document", {
      parentId: nestedFolder.id,
      projectId: sub.id,
    });
  const captured = await request("POST", "/templates/capture", {
    operationId: randomUUID(),
    sourceId: f.a.id,
    expectedVersion: f.a.version,
    title: "Tree template",
    anchorDate: "2026-11-03",
    shared: false,
  });
  assert.equal(captured.statusCode, 200, captured.body);
  const template = await get(
    captured.json().resource?.id ||
      captured.json().id ||
      captured.json().templateId,
  );
  const response = await request("POST", `/templates/${template.id}/apply`, {
    operationId: randomUUID(),
    expectedVersion: template.version,
    title: "Cloned tree",
    baseDate: "2026-11-03",
    visibility: "workspace",
  });
  assert.equal(response.statusCode, 200, response.body);
  const all = (await request("GET", "/resources")).json()
      .resources as Resource[],
    clones = all.filter((r) => response.json().ids.includes(r.id)),
    cloneSub = clones.find(
      (r) => r.kind === "project" && r.title === sub.title,
    )!,
    cloneFolder = clones.find(
      (r) => r.kind === "folder" && r.title === nestedFolder.title,
    )!,
    cloneDoc = clones.find((r) => r.title === nestedDoc.title)!;
  assert.equal(cloneFolder.data.parentId, cloneSub.id);
  assert.equal(cloneFolder.data.projectId, cloneSub.id);
  assert.equal(cloneDoc.data.parentId, cloneFolder.id);
  assert.equal(cloneDoc.data.projectId, cloneSub.id);
  assert.equal(projectAt(cloneDoc.id, all), cloneSub.id);
  assert.equal(structurePath(cloneDoc.id, all).length, 5);
});

test("move retries retain original scope permissions after the resource becomes publicly readable", async () => {
  const source = await make("project", "Formerly restricted source", {
      private: true,
      members: [memberId],
    }),
    destination = await make("project", "Public retry destination"),
    folder = await make("folder", "Moved by member", {
      parentId: source.id,
      projectId: source.id,
    });
  const plan = await preview(folder.id, destination.id, memberCookie),
    operationId = randomUUID();
  assert.equal((await move(plan, operationId, memberCookie)).statusCode, 200);
  assert.equal((await edit(source, { members: [] })).statusCode, 200);
  assert.equal(
    (
      await request(
        "GET",
        `/api/resources/${folder.id}/location`,
        undefined,
        memberCookie,
      )
    ).statusCode,
    200,
  );
  assert.equal((await move(plan, operationId, memberCookie)).statusCode, 403);
});

test("deleting a folder hides its live descendants and restoration recovers the same structure", async () => {
  const f = await branch();
  const removed = await request("POST", "/mutate", {
    operationId: randomUUID(),
    id: f.folder.id,
    kind: "folder",
    title: f.folder.title,
    data: f.folder.data,
    expectedVersion: f.folder.version,
    deleted: true,
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const visible = (
    await request("GET", "/resources", undefined, memberCookie)
  ).json().resources;
  for (const doc of [f.doc, f.child])
    assert.equal(
      visible.some((r: Resource) => r.id === doc.id),
      false,
    );
  const restored = await edit(removed.json().resource, {});
  assert.equal(restored.statusCode, 200, restored.body);
  const after = (
    await request("GET", "/resources", undefined, memberCookie)
  ).json().resources;
  for (const doc of [f.doc, f.child])
    assert.equal(
      after.some((r: Resource) => r.id === doc.id),
      true,
    );
});

test("moving a container preserves the deletion timestamp of trashed descendants", async () => {
  const f = await branch();
  const deletion = await request("POST", "/mutate", {
    operationId: randomUUID(),
    id: f.child.id,
    kind: "document",
    title: f.child.title,
    data: f.child.data,
    expectedVersion: f.child.version,
    deleted: true,
  });
  assert.equal(deletion.statusCode, 200, deletion.body);
  const removed = deletion.json().resource,
    plan = await preview(f.folder.id, f.b.id),
    result = await move(plan);
  assert.equal(result.statusCode, 200, result.body);
  const after = await get(f.child.id);
  assert.equal(
    new Date(after.deleted_at!).toISOString(),
    new Date(removed.deleted_at).toISOString(),
  );
  assert.equal(after.data.projectId, f.b.id);
  assert.equal(after.version, removed.version + 1);
});
