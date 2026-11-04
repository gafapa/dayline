import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { documentExtensions } from "../shared/editor-schema";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { defaultTaskView, filterTaskView } from "../shared/collections";
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
const headers = { origin: "http://test.local", "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1" };
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
      email: "collections-owner@example.test",
      password: "test-password-long-enough",
      name: "Owner",
      workspaceName: "Collections tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  ownerId = me.user.id;
  workspaceId = me.workspaces[0].id;
  const member = await invite("collections-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerCookie = (await invite("collections-viewer@example.test", "viewer"))
    .cookie;
});
after(async () => {
  await api.app.close();
  await db.close();
});
const blueprint = (kind = "task") => ({
  version: 1,
  rootKey: "root",
  nodes: [
    {
      key: "root",
      kind,
      title: "Reusable work",
      data: { description: "Portable description" },
      dependencies: [] as string[],
      related: [],
    },
  ],
});
test("saved task filters support relative people/dates, archiving and deterministic ordering", () => {
  const task = (title: string, data: any): Resource => ({
    id: randomUUID(),
    workspace_id: workspaceId,
    kind: "task",
    title,
    data,
    version: 1,
    created_by: ownerId,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
    deleted_at: null,
  });
  const a = task("Urgent release", {
      assigneeId: ownerId,
      status: "todo",
      priority: "urgent",
      dueDate: "2026-11-02",
      labels: ["release"],
      estimate: 3,
    }),
    b = task("Undated work", {
      assigneeId: memberId,
      status: "done",
      priority: "high",
    }),
    c = task("Archived release", {
      assigneeId: ownerId,
      status: "todo",
      archived: true,
      dueDate: "2026-11-03",
      labels: ["release"],
    });
  assert.deepEqual(
    filterTaskView(
      [a, b, c],
      {
        ...defaultTaskView(),
        assignees: ["me"],
        due: "overdue",
        labels: ["release"],
      },
      ownerId,
      new Date("2026-11-03T12:00:00Z"),
    ).map((t) => t.id),
    [a.id],
  );
  assert.deepEqual(
    filterTaskView(
      [a, b, c],
      {
        ...defaultTaskView(),
        assignees: ["me"],
        due: "week",
        showArchived: true,
      },
      ownerId,
      new Date("2026-11-03T12:00:00Z"),
    )
      .map((t) => t.id)
      .sort(),
    [a.id, c.id].sort(),
  );
  assert.equal(
    filterTaskView(
      [a, b],
      { ...defaultTaskView(), sortBy: "due", direction: "desc" },
      ownerId,
    )[1].id,
    b.id,
  );
  assert.deepEqual(
    filterTaskView(
      [a, b, c],
      { ...defaultTaskView(), assignees: ["me"] },
      memberId,
    ).map((t) => t.id),
    [b.id],
  );
});
test("private saved views and scoped shared views do not reveal private project filters", async () => {
  const project = await make("project", "Private filter source", {
      private: true,
      members: [],
    }),
    config = { ...defaultTaskView(), projectIds: [project.id] };
  const view = await make("view", "Scoped shared filter", {
    viewConfig: config,
  });
  const personal = await make("view", "Personal view", {
    ownerId: ownerId,
    viewConfig: defaultTaskView(),
  });
  const resources = (
    await request("GET", base() + "/resources", undefined, memberCookie)
  ).json().resources;
  assert.ok(
    !resources.some((r: Resource) => [view.id, personal.id].includes(r.id)),
  );
  const response = await request("POST", base() + "/mutate", {
    id: randomUUID(),
    operationId: randomUUID(),
    kind: "view",
    title: "Invalid foreign scope",
    data: { viewConfig: { ...defaultTaskView(), projectIds: [randomUUID()] } },
    expectedVersion: 0,
  });
  assert.equal(response.statusCode, 400);
  const shared = await make("view", "Team view", {
    viewConfig: defaultTaskView(),
  });
  assert.equal(
    (
      await request(
        "POST",
        base() + "/mutate",
        {
          id: shared.id,
          operationId: randomUUID(),
          kind: "view",
          title: "Unowned edit",
          data: shared.data,
          expectedVersion: 1,
        },
        memberCookie,
      )
    ).statusCode,
    403,
  );
});
test("bulk editing is versioned, idempotent, permission-scoped and reversible through trash", async () => {
  const a = await make("task", "Bulk A", { status: "todo", labels: ["old"] }),
    b = await make("task", "Bulk B", { status: "todo", labels: [] });
  const body = {
    operationId: randomUUID(),
    tasks: [a, b].map((task) => ({ id: task.id, expectedVersion: 1 })),
    mode: "update",
    patch: {
      status: "review",
      addLabels: ["team"],
      removeLabels: ["old"],
      priority: "high",
    },
  };
  const response = await request("POST", base() + "/tasks/bulk", body);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await current(a.id)).data.status, "review");
  assert.deepEqual((await current(a.id)).data.labels, ["team"]);
  assert.equal(
    (await request("POST", base() + "/tasks/bulk", body)).statusCode,
    200,
  );
  assert.equal((await current(a.id)).version, 2);
  const stale = await request("POST", base() + "/tasks/bulk", {
    ...body,
    operationId: randomUUID(),
    patch: { status: "done" },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal((await current(b.id)).data.status, "review");
  assert.equal(
    (
      await request(
        "POST",
        base() + "/tasks/bulk",
        { ...body, operationId: randomUUID() },
        viewerCookie,
      )
    ).statusCode,
    403,
  );
  const trash = await request("POST", base() + "/tasks/bulk", {
    operationId: randomUUID(),
    mode: "trash",
    tasks: [a, b].map((task) => ({ id: task.id, expectedVersion: 2 })),
  });
  assert.equal(trash.statusCode, 200, trash.body);
  assert.ok((await current(a.id)).deleted_at);
  const restore = await request("POST", base() + "/tasks/bulk", {
    operationId: randomUUID(),
    mode: "restore",
    tasks: trash.json().versions.map((item: any) => ({
      id: item.id,
      expectedVersion: item.version,
    })),
  });
  assert.equal(restore.statusCode, 200, restore.body);
  assert.equal((await current(a.id)).deleted_at, null);
  const project = await make("project", "Private batch", {
      private: true,
      members: [],
    }),
    secret = await make("task", "Private batch task", {
      projectId: project.id,
      status: "todo",
    });
  const denied = await request(
    "POST",
    base() + "/tasks/bulk",
    {
      operationId: randomUUID(),
      tasks: [
        { id: b.id, expectedVersion: (await current(b.id)).version },
        { id: secret.id, expectedVersion: 1 },
      ],
      patch: { status: "done" },
    },
    memberCookie,
  );
  assert.equal(denied.statusCode, 403);
  assert.equal((await current(b.id)).data.status, "review");
});
test("a late validation failure rolls back earlier bulk effects and queued recurrence", async () => {
  const a = await make("task", "Early valid write", {
      status: "todo",
      recurrence: "daily",
      dueDate: "2026-11-03",
    }),
    b = await make("task", "Late invalid reference", { status: "todo" });
  await db.query(
    "UPDATE resources SET data=jsonb_set(data,'{dependencies}',$1::jsonb) WHERE id=$2",
    [JSON.stringify([randomUUID()]), b.id],
  );
  const response = await request("POST", base() + "/tasks/bulk", {
    operationId: randomUUID(),
    tasks: [a, b].map((task) => ({ id: task.id, expectedVersion: 1 })),
    patch: { status: "done" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal((await current(a.id)).data.status, "todo");
  assert.equal((await current(a.id)).version, 1);
  assert.equal(
    (await db.query("SELECT * FROM automation_runs WHERE target_id=$1", [a.id]))
      .rows.length,
    0,
  );
});
test("project templates capture canonical collaborative content, copy files, remap references and reset execution state", async () => {
  const project = await make("project", "Template source", {
      description: "Repeatable delivery",
    }),
    subproject = await make("project", "Private nested project", {
      parentId: project.id,
      private: true,
      members: [],
    }),
    sprint = await make("sprint", "Source sprint", { status: "active" }),
    parent = await make("task", "Parent checklist", {
      projectId: project.id,
      sprintId: sprint.id,
      status: "done",
      assigneeId: ownerId,
      estimate: 3,
      recurrence: "daily",
      dueDate: "2026-11-10",
      checklist: [{ id: "source-check", text: "Review code", done: true }],
    }),
    child = await make("task", "Dependent subtask", {
      projectId: project.id,
      parentId: parent.id,
      status: "review",
      dependencies: [parent.id],
    }),
    document = await make("document", "Source notes", {
      projectId: project.id,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Stale metadata projection" }],
          },
        ],
      },
    });
  const uploaded = await request(
    "POST",
    base() + `/resources/${document.id}/attachments`,
    {
      name: "pixel.png",
      mime: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWoAAAAASUVORK5CYII=",
    },
  );
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const originalUrl = uploaded.json().attachment.url;
  const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Canonical saved notes" },
            {
              type: "text",
              text: "Linked task",
              marks: [
                { type: "link", attrs: { href: "/?resource=" + parent.id } },
              ],
            },
          ],
        },
        { type: "image", attrs: { src: originalUrl } },
      ],
    },
    ydoc = prosemirrorJSONToYDoc(
      getSchema(documentExtensions()),
      content,
      "default",
    );
  await db.query(
    "INSERT INTO document_states(resource_id,state) VALUES($1,$2)",
    [document.id, Buffer.from(Y.encodeStateAsUpdate(ydoc))],
  );
  ydoc.destroy();
  const captured = await request("POST", base() + "/templates/capture", {
    operationId: randomUUID(),
    sourceId: project.id,
    expectedVersion: 1,
    title: "Delivery template",
    anchorDate: "2026-11-03",
    shared: true,
  });
  assert.equal(captured.statusCode, 200, captured.body);
  assert.equal(captured.json().nodeCount, 5);
  assert.equal(captured.json().attachmentCount, 1);
  const template = await current(captured.json().templateId);
  assert.ok(
    template.data.templateScopes.some(
      (scope: any) => scope.id === subproject.id,
    ),
  );
  assert.ok(
    !(await request("GET", base() + "/resources", undefined, memberCookie))
      .json()
      .resources.some((r: Resource) => r.id === template.id),
  );
  const applyBody = {
      operationId: randomUUID(),
      expectedVersion: template.version,
      title: "New delivery project",
      baseDate: "2027-05-01",
      visibility: "private",
    },
    applied = await request(
      "POST",
      base() + `/templates/${template.id}/apply`,
      applyBody,
    );
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().count, 5);
  const copies = (
      await db.query<Resource>(
        "SELECT * FROM resources WHERE id=ANY($1::uuid[])",
        [applied.json().ids],
      )
    ).rows,
    newParent = copies.find((r) => r.title === parent.title)!,
    newChild = copies.find((r) => r.title === child.title)!,
    newDoc = copies.find((r) => r.title === document.title)!;
  assert.equal(newParent.data.status, "backlog");
  assert.equal(newParent.data.assigneeId, undefined);
  assert.equal(newParent.data.sprintId, undefined);
  assert.equal(newParent.data.recurrence, undefined);
  assert.equal(newParent.data.dueDate, "2027-05-08");
  assert.equal(newParent.data.checklist[0].done, false);
  assert.notEqual(newParent.data.checklist[0].id, "source-check");
  assert.equal(newChild.data.parentId, newParent.id);
  assert.deepEqual(newChild.data.dependencies, [newParent.id]);
  assert.equal(
    documentText(newDoc.data.content).includes("Canonical saved notes"),
    true,
  );
  assert.equal(
    JSON.stringify(newDoc.data.content).includes("/?resource=" + newParent.id),
    true,
  );
  assert.equal(
    JSON.stringify(newDoc.data.content).includes(originalUrl),
    false,
  );
  const image = newDoc.data.content.content.find(
      (node: any) => node.type === "image",
    ).attrs.src,
    response = await request("GET", image);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(
    (await request("GET", image, undefined, memberCookie)).statusCode,
    404,
  );
  const before = (await db.query("SELECT count(*) AS count FROM attachments"))
    .rows[0].count;
  assert.equal(
    (
      await request(
        "POST",
        base() + `/templates/${template.id}/apply`,
        applyBody,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await db.query("SELECT count(*) AS count FROM attachments")).rows[0].count,
    before,
  );
});
test("captured source scopes cannot be stripped and revoked access also blocks operation replay", async () => {
  let project = await make("project", "Revocable public source");
  const captureBody = {
    operationId: randomUUID(),
    sourceId: project.id,
    expectedVersion: 1,
    title: "Member private copy",
    anchorDate: "2026-11-03",
  };
  const captured = await request(
    "POST",
    base() + "/templates/capture",
    captureBody,
    memberCookie,
  );
  assert.equal(captured.statusCode, 200, captured.body);
  const template = await current(captured.json().templateId);
  const forged = await request(
    "POST",
    base() + "/mutate",
    {
      id: template.id,
      operationId: randomUUID(),
      kind: "template",
      title: template.title,
      data: { ...template.data, templateScopes: [], targetId: null },
      expectedVersion: 1,
    },
    memberCookie,
  );
  assert.equal(forged.statusCode, 400);
  project = await edit(project, { private: true, members: [] });
  assert.equal(
    (
      await request(
        "POST",
        base() + "/templates/capture",
        captureBody,
        memberCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        base() + `/templates/${template.id}/apply`,
        {
          operationId: randomUUID(),
          expectedVersion: 1,
          title: "Unauthorized application",
          baseDate: "2026-11-03",
          visibility: "private",
        },
        memberCookie,
      )
    ).statusCode,
    404,
  );
});
test("template validation rejects dependency cycles, forged images and executable links", async () => {
  const a = blueprint();
  a.nodes.push({
    key: "child",
    kind: "task",
    title: "Child",
    data: {},
    dependencies: ["root"],
    related: [],
    parentKey: "root",
  } as any);
  a.nodes[0].dependencies = ["child"];
  for (const candidate of [
    a,
    {
      version: 1,
      rootKey: "root",
      nodes: [
        {
          key: "root",
          kind: "document",
          title: "Unsafe",
          dependencies: [] as string[],
          related: [],
          data: {
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Unsafe link",
                      marks: [
                        {
                          type: "link",
                          attrs: { href: "javascript:alert(1)" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    },
    {
      version: 1,
      rootKey: "root",
      nodes: [
        {
          key: "root",
          kind: "document",
          title: "Unowned image",
          dependencies: [] as string[],
          related: [],
          data: {
            content: {
              type: "doc",
              content: [
                {
                  type: "image",
                  attrs: { src: base() + "/attachments/" + randomUUID() },
                },
              ],
            },
          },
        },
      ],
    },
  ]) {
    const response = await request("POST", base() + "/mutate", {
      id: randomUUID(),
      operationId: randomUUID(),
      kind: "template",
      title: "Invalid template",
      data: { ownerId: ownerId, templateBlueprint: candidate },
      expectedVersion: 0,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
});

test("template date overflow rejects the entire copy without creating resources", async () => {
  const value = blueprint();
  const template = await make("template", "Boundary date template", {
    ownerId: ownerId,
    templateBlueprint: {
      ...value,
      nodes: value.nodes.map((node) => ({ ...node, dueOffset: 10 })),
    },
  });
  const before = Number(
    (await db.query("SELECT count(*) AS count FROM resources")).rows[0].count,
  );
  const response = await request(
    "POST",
    base() + `/templates/${template.id}/apply`,
    {
      operationId: randomUUID(),
      expectedVersion: template.version,
      title: "Invalid future date",
      baseDate: "9999-12-31",
      visibility: "workspace",
    },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(
    Number(
      (await db.query("SELECT count(*) AS count FROM resources")).rows[0].count,
    ),
    before,
  );
});
