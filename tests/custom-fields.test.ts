import { defaultTaskView, filterTaskView } from "../shared/collections";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import {
  fieldDefinitionSchema,
  type FieldDefinition,
} from "../shared/custom-fields";
import type { Resource } from "../shared/model";
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  workspaceId: string,
  ownerId: string,
  memberId: string,
  ownerCookie: string,
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
    url: path.startsWith("/api")
      ? path
      : `/api/workspaces/${workspaceId}${path}`,
    payload,
    headers: { ...headers, cookie },
  });
const get = async (id: string) =>
  (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id]))
    .rows[0];
const field = (
  type: FieldDefinition["type"],
  patch: Partial<FieldDefinition> = {},
) =>
  fieldDefinitionSchema.parse({
    id: randomUUID(),
    name: type + " field",
    type,
    ...patch,
  });
async function make(
  kind: string,
  title: string,
  data: any = {},
  cookie = ownerCookie,
) {
  const response = await request(
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
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
const edit = (r: Resource, data: any, cookie = ownerCookie) =>
  request(
    "POST",
    "/mutate",
    {
      operationId: randomUUID(),
      id: r.id,
      kind: r.kind,
      title: r.title,
      data: { ...r.data, ...data },
      expectedVersion: r.version,
    },
    cookie,
  );
const fieldPath = (projectId: string, action: string) =>
  `/projects/${projectId}/fields/${action}`;
async function plan(
  project: Resource,
  definitions: FieldDefinition[],
  fillMissing = false,
  cookie = ownerCookie,
) {
  const body = { definitions, expectedVersion: project.version, fillMissing },
    response = await request(
      "POST",
      fieldPath(project.id, "preview"),
      body,
      cookie,
    );
  assert.equal(response.statusCode, 200, response.body);
  return {
    ...body,
    fingerprint: response.json().fingerprint,
    operationId: randomUUID(),
  };
}
async function configure(
  project: Resource,
  definitions: FieldDefinition[],
  fillMissing = false,
  cookie = ownerCookie,
) {
  const input = await plan(project, definitions, fillMissing, cookie),
    response = await request(
      "POST",
      fieldPath(project.id, "apply"),
      input,
      cookie,
    );
  assert.equal(response.statusCode, 200, response.body);
  return { project: await get(project.id), input, response };
}
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, {
    origin: "http://test.local",
    setupToken: "fields-test-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await request(
    "POST",
    "/api/setup",
    {
      email: "fields-owner@example.test",
      name: "Owner",
      password: "fields-password-long",
      workspaceName: "Field tests",
      setupToken: "fields-test-setup",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const profile = (await request("GET", "/api/me")).json();
  workspaceId = profile.workspaces[0].id;
  ownerId = profile.user.id;
  for (const role of ["member", "viewer"]) {
    const email = `fields-${role}@example.test`,
      invitation = await request("POST", "/invitations", { email, role });
    assert.equal(invitation.statusCode, 200, invitation.body);
    const accepted = await request(
      "POST",
      "/api/invitations/accept",
      {
        email,
        name: role,
        password: "fields-password-long",
        token: new URL(invitation.json().url).searchParams.get("invitation"),
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

test("project fields validate all eight types and apply defaults to new tasks", async () => {
  const choice = randomUUID(),
    second = randomUUID(),
    definitions = [
      field("text", { maxLength: 8, defaultValue: "initial" }),
      field("number", { min: 0, max: 10, defaultValue: 0 }),
      field("boolean", { required: true, defaultValue: false }),
      field("date", { defaultValue: "2026-11-03" }),
      field("select", {
        options: [{ id: choice, label: "First", archived: false }],
        defaultValue: choice,
      }),
      field("multiselect", {
        options: [
          { id: choice, label: "First", archived: false },
          { id: second, label: "Second", archived: false },
        ],
        defaultValue: [choice],
      }),
      field("url", { defaultValue: "https://example.test/reference" }),
      field("person", { defaultValue: memberId }),
    ];
  const project = await make("project", "Typed project", {
      fieldDefinitions: definitions,
    }),
    task = await make("task", "Defaulted task", {
      projectId: project.id,
      status: "todo",
    });
  assert.equal(task.data.customFields[definitions[1].id], 0);
  assert.equal(task.data.customFields[definitions[2].id], false);
  assert.equal(task.data.fieldSnapshots.length, 8);
  const invalid = [
    "overlong text",
    -1,
    "false",
    "2026-02-30",
    "First",
    [choice, choice],
    "javascript:alert(1)",
    randomUUID(),
  ];
  for (let i = 0; i < definitions.length; i++) {
    const response = await edit(task, {
      customFields: {
        ...task.data.customFields,
        [definitions[i].id]: invalid[i],
      },
    });
    assert.equal(
      response.statusCode,
      400,
      `${definitions[i].type}: ${response.body}`,
    );
  }
});

test("required defaults backfill tasks atomically and concurrent command replay does not duplicate versions", async () => {
  const project = await make("project", "Backfill project"),
    a = await make("task", "First", { projectId: project.id }),
    b = await make("task", "Second", { projectId: project.id }),
    definition = field("number", {
      name: "Impact",
      required: true,
      defaultValue: 3,
    }),
    input = await plan(project, [definition]);
  const responses = await Promise.all([
    request("POST", fieldPath(project.id, "apply"), input),
    request("POST", fieldPath(project.id, "apply"), input),
  ]);
  for (const response of responses)
    assert.equal(response.statusCode, 200, response.body);
  assert.equal((await get(project.id)).version, 2);
  for (const task of [a, b]) {
    const current = await get(task.id);
    assert.equal(current.version, 2);
    assert.equal(current.data.customFields[definition.id], 3);
  }
  const replay = await request("POST", fieldPath(project.id, "apply"), input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((await get(a.id)).version, 2);
  assert.equal(
    (
      await request("POST", fieldPath(project.id, "apply"), {
        ...input,
        fillMissing: true,
      })
    ).statusCode,
    409,
  );
});

test("optional defaults fill existing records only when explicitly reviewed", async () => {
  let project = await make("project", "Optional defaults");
  const task = await make("task", "Existing", { projectId: project.id }),
    definition = field("text", { defaultValue: "fallback" });
  project = (await configure(project, [definition])).project;
  assert.equal(
    (await get(task.id)).data.customFields[definition.id],
    undefined,
  );
  const configured = await configure(project, [definition], true);
  assert.equal(configured.response.json().changedTaskCount, 1);
  assert.equal(
    (await get(task.id)).data.customFields[definition.id],
    "fallback",
  );
});

test("definition changes require project ownership or administration and cannot bypass reviewed updates", async () => {
  const project = await make("project", "Managed definitions"),
    definition = field("text");
  assert.equal(
    (
      await request(
        "POST",
        fieldPath(project.id, "preview"),
        { definitions: [definition], expectedVersion: project.version },
        memberCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        fieldPath(project.id, "preview"),
        { definitions: [definition], expectedVersion: project.version },
        viewerCookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await edit(project, { fieldDefinitions: [definition] }, memberCookie))
      .statusCode,
    403,
  );
  assert.equal(
    (await edit(project, { fieldDefinitions: [definition] })).statusCode,
    409,
  );
  const own = await make("project", "Member-owned project", {}, memberCookie);
  assert.equal(
    (await configure(own, [definition], false, memberCookie)).project.data
      .fieldDefinitions.length,
    1,
  );
});

test("stale plans reject edited tasks, added tasks and project changes without partial updates", async () => {
  const project = await make("project", "Stale fields"),
    task = await make("task", "Existing", { projectId: project.id }),
    definition = field("boolean", { required: true, defaultValue: false });
  let input = await plan(project, [definition]);
  assert.equal(
    (await edit(task, { description: "Concurrent edit" })).statusCode,
    200,
  );
  assert.equal(
    (await request("POST", fieldPath(project.id, "apply"), input)).statusCode,
    409,
  );
  input = await plan(project, [definition]);
  await make("task", "Added later", { projectId: project.id });
  assert.equal(
    (await request("POST", fieldPath(project.id, "apply"), input)).statusCode,
    409,
  );
  assert.equal((await get(project.id)).version, 1);
  input = await plan(project, [definition]);
  assert.equal(
    (await edit(project, { description: "Changed project" })).statusCode,
    200,
  );
  assert.equal(
    (await request("POST", fieldPath(project.id, "apply"), input)).statusCode,
    409,
  );
});

test("field renames and archival preserve values while incompatible constraints and destructive schema changes are rejected", async () => {
  const option = randomUUID();
  let definition = field("select", {
      name: "Area",
      options: [{ id: option, label: "API", archived: false }],
    }),
    project = await make("project", "Stable field identity", {
      fieldDefinitions: [definition],
    });
  const task = await make("task", "Existing choice", {
    projectId: project.id,
    customFields: { [definition.id]: option },
  });
  definition = {
    ...definition,
    name: "Component",
    options: [{ id: option, label: "Backend", archived: false }],
  };
  project = (await configure(project, [definition])).project;
  assert.equal((await get(task.id)).version, 1);
  assert.equal((await get(task.id)).data.customFields[definition.id], option);
  assert.equal(
    (
      await request("POST", fieldPath(project.id, "preview"), {
        definitions: [],
        expectedVersion: project.version,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request("POST", fieldPath(project.id, "preview"), {
        definitions: [{ ...definition, type: "text", options: [] }],
        expectedVersion: project.version,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request("POST", fieldPath(project.id, "preview"), {
        definitions: [{ ...definition, options: [] }],
        expectedVersion: project.version,
      })
    ).statusCode,
    409,
  );
  definition = { ...definition, archived: true };
  await configure(project, [definition]);
  const updated = await edit(await get(task.id), {
    description: "Unrelated edit",
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(
    updated.json().resource.data.customFields[definition.id],
    option,
  );
  assert.equal(
    (await edit(updated.json().resource, { customFields: {} })).statusCode,
    409,
  );
});

test("required fields without defaults cannot invalidate existing tasks and numeric bounds respect stored values", async () => {
  let project = await make("project", "Constraint consistency");
  const task = await make("task", "Existing task", { projectId: project.id }),
    definition = field("number");
  assert.equal(
    (
      await request("POST", fieldPath(project.id, "preview"), {
        definitions: [{ ...definition, required: true }],
        expectedVersion: project.version,
      })
    ).statusCode,
    409,
  );
  project = (await configure(project, [definition])).project;
  const updated = await edit(await get(task.id), {
    customFields: { [definition.id]: 5 },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(
    (
      await request("POST", fieldPath(project.id, "preview"), {
        definitions: [{ ...definition, max: 3 }],
        expectedVersion: project.version,
      })
    ).statusCode,
    409,
  );
  assert.equal((await get(task.id)).data.customFields[definition.id], 5);
});

test("moving a task preserves read-only origin values and rejects forged metadata", async () => {
  const definition = field("text"),
    source = await make("project", "Origin schema", {
      fieldDefinitions: [definition],
    }),
    target = await make("project", "Unconfigured target"),
    task = await make("task", "Movable", {
      projectId: source.id,
      customFields: { [definition.id]: "Retained" },
    });
  const moved = await edit(task, { projectId: target.id });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(
    moved.json().resource.data.fieldSnapshots[0].sourceProjectId,
    source.id,
  );
  assert.equal(
    (
      await edit(moved.json().resource, {
        customFields: { [definition.id]: "Changed" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await edit(moved.json().resource, { fieldSnapshots: [] })).statusCode,
    400,
  );
  const cleared = await edit(moved.json().resource, { customFields: {} });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().resource.data.fieldSnapshots, undefined);
  const forged = await request("POST", "/mutate", {
    operationId: randomUUID(),
    id: randomUUID(),
    kind: "task",
    title: "Forged field",
    data: {
      projectId: target.id,
      customFields: { [randomUUID()]: "Injected" },
    },
    expectedVersion: 0,
  });
  assert.equal(forged.statusCode, 400);
});

test("late task validation failure rolls back field definitions, backfill and the operation receipt", async () => {
  const project = await make("project", "Rollback fields"),
    task = await make("task", "Scheduled task", {
      projectId: project.id,
      recurrence: "daily",
      dueDate: "2026-11-03",
      timeZone: "UTC",
    });
  await db.query(
    "UPDATE resources SET data=jsonb_set(data,'{timeZone}','\"Invalid/Zone\"') WHERE id=$1",
    [task.id],
  );
  const definition = field("number", { required: true, defaultValue: 2 }),
    input = await plan(project, [definition]),
    response = await request("POST", fieldPath(project.id, "apply"), input);
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((await get(project.id)).version, 1);
  assert.equal((await get(task.id)).version, 1);
  assert.equal(
    (await get(task.id)).data.customFields[definition.id],
    undefined,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM operations WHERE id=$1", [
        input.operationId,
      ])
    ).rows.length,
    0,
  );
});

test("project and task templates preserve configured values and origin schemas", async () => {
  const definition = field("multiselect", {
      options: [{ id: randomUUID(), label: "Security", archived: false }],
    }),
    project = await make("project", "Field template", {
      fieldDefinitions: [definition],
    }),
    task = await make("task", "Template task", {
      projectId: project.id,
      customFields: { [definition.id]: [definition.options[0].id] },
    });
  for (const source of [project, task]) {
    const captured = await request("POST", "/templates/capture", {
      operationId: randomUUID(),
      sourceId: source.id,
      expectedVersion: source.version,
      title: "Field template capture",
      anchorDate: "2026-11-03",
      shared: false,
    });
    assert.equal(captured.statusCode, 200, captured.body);
    const template = await get(captured.json().templateId),
      applied = await request("POST", `/templates/${template.id}/apply`, {
        operationId: randomUUID(),
        expectedVersion: template.version,
        title: "Field template copy",
        baseDate: "2026-11-03",
        visibility: "workspace",
      });
    assert.equal(applied.statusCode, 200, applied.body);
    const clone = (
      await db.query<Resource>(
        "SELECT * FROM resources WHERE id=ANY($1::uuid[]) AND kind='task'",
        [applied.json().ids],
      )
    ).rows[0];
    assert.deepEqual(clone.data.customFields[definition.id], [
      definition.options[0].id,
    ]);
    assert.equal(clone.data.fieldSnapshots[0].id, definition.id);
  }
});

test("saved field filters and visible properties keep project privacy and typed comparisons", async () => {
  const score = field("number"),
    done = field("boolean"),
    project = await make("project", "Filter project", {
      fieldDefinitions: [score, done],
    }),
    a = await make("task", "Zero", {
      projectId: project.id,
      customFields: { [score.id]: 0, [done.id]: false },
    }),
    b = await make("task", "High", {
      projectId: project.id,
      customFields: { [score.id]: 5, [done.id]: true },
    });
  const config = {
    ...defaultTaskView(),
    fieldFilters: [
      {
        projectId: project.id,
        fieldId: score.id,
        operator: "gte" as const,
        value: 3,
      },
    ],
    fieldColumns: [{ projectId: project.id, fieldId: score.id }],
  };
  assert.deepEqual(
    filterTaskView([a, b], config, ownerId).map((r) => r.id),
    [b.id],
  );
  assert.deepEqual(
    filterTaskView(
      [a, b],
      {
        ...config,
        fieldFilters: [
          {
            projectId: project.id,
            fieldId: done.id,
            operator: "is",
            value: false,
          },
        ],
      },
      ownerId,
    ).map((r) => r.id),
    [a.id],
  );
  const view = await make("view", "Shared typed filter", {
    viewConfig: config,
  });
  assert.equal(
    (await edit(project, { private: true, members: [] })).statusCode,
    200,
  );
  assert.equal(
    (await request("GET", "/resources", undefined, memberCookie))
      .json()
      .resources.some((r: Resource) => r.id === view.id),
    false,
  );
  const invalid = await request("POST", "/mutate", {
    operationId: randomUUID(),
    id: randomUUID(),
    kind: "view",
    title: "Invalid typed comparison",
    data: {
      viewConfig: {
        ...config,
        fieldFilters: [
          {
            projectId: project.id,
            fieldId: done.id,
            operator: "gt",
            value: true,
          },
        ],
      },
    },
    expectedVersion: 0,
  });
  assert.equal(invalid.statusCode, 400);
});

test("bulk field updates merge existing values and roll back the whole selection on an invalid field", async () => {
  const score = field("number", { max: 10 }),
    flag = field("boolean"),
    project = await make("project", "Bulk project", {
      fieldDefinitions: [score, flag],
    }),
    a = await make("task", "Bulk A", {
      projectId: project.id,
      customFields: { [score.id]: 1, [flag.id]: false },
    }),
    b = await make("task", "Bulk B", {
      projectId: project.id,
      customFields: { [score.id]: 2, [flag.id]: true },
    });
  const tasks = [a, b].map((r) => ({ id: r.id, expectedVersion: r.version }));
  const body = {
      operationId: randomUUID(),
      tasks,
      mode: "update",
      patch: { customFields: { [score.id]: 7 } },
    },
    result = await request("POST", "/tasks/bulk", body);
  assert.equal(result.statusCode, 200, result.body);
  for (const [task, expected] of [
    [a, false],
    [b, true],
  ] as const) {
    const current = await get(task.id);
    assert.equal(current.data.customFields[score.id], 7);
    assert.equal(current.data.customFields[flag.id], expected);
  }
  const invalid = await request("POST", "/tasks/bulk", {
    ...body,
    operationId: randomUUID(),
    tasks: tasks.map((r) => ({ ...r, expectedVersion: r.expectedVersion + 1 })),
    patch: { customFields: { [score.id]: 99 } },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal((await get(a.id)).version, 2);
  assert.equal((await get(b.id)).version, 2);
});

test("task schema snapshots contain only the selected option metadata and omit unrelated project defaults", async () => {
  const selected = randomUUID(),
    unused = randomUUID(),
    definition = field("select", {
      description: "Project-only description",
      defaultValue: unused,
      options: [
        { id: selected, label: "Selected label", archived: false },
        { id: unused, label: "Unselected project label", archived: false },
      ],
    }),
    project = await make("project", "Minimized snapshots", {
      fieldDefinitions: [definition],
    }),
    task = await make("task", "Selected metadata", {
      projectId: project.id,
      customFields: { [definition.id]: selected },
    });
  const snapshot = task.data.fieldSnapshots[0];
  assert.equal(snapshot.description, "");
  assert.equal(snapshot.defaultValue, undefined);
  assert.deepEqual(
    snapshot.options.map((o: any) => o.id),
    [selected],
  );
  assert.equal(
    JSON.stringify(snapshot).includes("Unselected project label"),
    false,
  );
});

test("field backfill refuses inaccessible legacy tasks without revealing their identifiers or titles", async () => {
  const project = await make(
    "project",
    "Shared configuration with private tasks",
  );
  const hidden = await make(
    "task",
    "Private task sentinel",
    { projectId: project.id },
    memberCookie,
  );
  // Simulate a legacy ownership marker that current ordinary task writes reject.
  await db.query(
    "UPDATE resources SET data=jsonb_set(data,'{ownerId}',to_jsonb($2::text)) WHERE id=$1",
    [hidden.id, memberId],
  );
  const definition = field("number", { required: true, defaultValue: 0 });
  const response = await request("POST", fieldPath(project.id, "preview"), {
    definitions: [definition],
    expectedVersion: project.version,
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.body.includes(hidden.id), false);
  assert.equal(response.body.includes(hidden.title), false);
  assert.equal((await get(project.id)).version, 1);
  assert.equal((await get(hidden.id)).version, 1);
  const optional = { ...definition, required: false };
  const allowed = await request("POST", fieldPath(project.id, "preview"), {
    definitions: [optional],
    expectedVersion: project.version,
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.json().changedTaskCount, 0);
});
