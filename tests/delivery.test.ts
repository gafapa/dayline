import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { documentExtensions } from "../shared/editor-schema";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { defaultDelivery } from "../shared/delivery";
import { documentText } from "../shared/documents";
import type { Resource } from "../shared/model";
import { canRead } from "../server/permissions";
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
      email: "delivery-owner@example.test",
      password: "test-password-long-enough",
      name: "Owner",
      workspaceName: "Delivery tests",
      setupToken: "test-setup-token",
    },
    "",
  );
  assert.equal(setup.statusCode, 200, setup.body);
  ownerCookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  ownerId = me.user.id;
  workspaceId = me.workspaces[0].id;
  const member = await invite("delivery-member@example.test", "member");
  memberId = member.id;
  memberCookie = member.cookie;
  viewerCookie = (await invite("delivery-viewer@example.test", "viewer"))
    .cookie;
});
after(async () => {
  await api.app.close();
  await db.close();
});
const draft = async (
  kind: "milestone" | "release" | "risk" | "decision",
  project: Resource,
  data: any = {},
) =>
  make(kind, "Delivery " + kind, {
    projectId: project.id,
    status:
      kind === "risk"
        ? "identified"
        : kind === "decision"
          ? "proposed"
          : "planned",
    goal: "Demonstrate a complete delivery",
    delivery: defaultDelivery(kind),
    ...data,
  });
const change = (resource: Resource, data: any = {}, cookie = ownerCookie) =>
  request(
    "POST",
    base() + "/mutate",
    {
      operationId: randomUUID(),
      id: resource.id,
      kind: resource.kind,
      title: resource.title,
      data: { ...resource.data, ...data },
      expectedVersion: resource.version,
    },
    cookie,
  );
async function confirmation(resource: Resource, cookie = ownerCookie) {
  const response = await request(
    "GET",
    base() + `/planning/${resource.id}/readiness`,
    undefined,
    cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  return {
    operationId: randomUUID(),
    expectedVersion: resource.version,
    expectedReferences: response
      .json()
      .references.map((r: Resource) => ({ id: r.id, version: r.version })),
    note: "Reviewed in delivery tests",
  };
}
const confirm = (resource: Resource, input: any, cookie = ownerCookie) =>
  request("POST", base() + `/planning/${resource.id}/confirm`, input, cookie);

test("milestones reject false completion, retain checked scope and replay a confirmation once", async () => {
  const project = await make("project", "Milestone scope"),
    task = await make("task", "Milestone task", {
      projectId: project.id,
      status: "todo",
      estimate: 5,
    }),
    milestone = await draft("milestone", project, {
      delivery: { type: "milestone", taskIds: [task.id], dependsOn: [] },
    });
  assert.equal(
    (await change(milestone, { status: "achieved" })).statusCode,
    400,
  );
  assert.equal(
    (await confirm(milestone, await confirmation(milestone))).statusCode,
    409,
  );
  await edit(task, { status: "done" });
  const body = await confirmation(milestone),
    response = await confirm(milestone, body);
  assert.equal(response.statusCode, 200, response.body);
  const frozen = await current(milestone.id);
  assert.equal(frozen.data.status, "achieved");
  assert.equal(
    frozen.data.deliveryReceipt.items.find((r: any) => r.id === task.id).status,
    "done",
  );
  assert.equal(
    frozen.data.deliveryReceipt.items.find((r: any) => r.id === task.id)
      .estimate,
    5,
  );
  assert.deepEqual((await confirm(frozen, body)).json(), response.json());
  await edit(await current(task.id), { status: "todo", estimate: 13 });
  assert.equal(
    (await current(milestone.id)).data.deliveryReceipt.items.find(
      (r: any) => r.id === task.id,
    ).estimate,
    5,
  );
  assert.equal(
    (await change(frozen, { goal: "Rewrite a historical claim" })).statusCode,
    409,
  );
  assert.equal(
    (await change(frozen, { deliveryReceipt: undefined })).statusCode,
    400,
  );
  assert.equal((await change(frozen, { archived: true })).statusCode, 200);
});

test("milestone dependencies reject cycles and private or unrelated project scope", async () => {
  const project = await make("project", "Dependency scope"),
    task = await make("task", "Dependency task", {
      projectId: project.id,
      status: "done",
    }),
    a = await draft("milestone", project, {
      delivery: { type: "milestone", taskIds: [task.id], dependsOn: [] },
    }),
    b = await draft("milestone", project, {
      delivery: { type: "milestone", taskIds: [task.id], dependsOn: [a.id] },
    });
  assert.equal(
    (await change(a, { delivery: { ...a.data.delivery, dependsOn: [b.id] } }))
      .statusCode,
    400,
  );
  const other = await make("project", "Different project"),
    otherTask = await make("task", "Different task", {
      projectId: other.id,
      status: "done",
    });
  assert.equal(
    (
      await change(a, {
        delivery: { ...a.data.delivery, taskIds: [otherTask.id] },
      })
    ).statusCode,
    400,
  );
  const privateProject = await make("project", "Hidden scope", {
      parentId: project.id,
      private: true,
    }),
    privateTask = await make("task", "Hidden task", {
      projectId: privateProject.id,
      status: "done",
    });
  assert.equal(
    (
      await change(
        a,
        { delivery: { ...a.data.delivery, taskIds: [privateTask.id] } },
        memberCookie,
      )
    ).statusCode,
    400,
  );
  const sub = await make("project", "Accessible nested scope", {
      parentId: project.id,
    }),
    subTask = await make("task", "Nested task", {
      projectId: sub.id,
      status: "done",
    });
  assert.equal(
    (
      await change(a, {
        delivery: { ...a.data.delivery, taskIds: [subTask.id] },
      })
    ).statusCode,
    200,
  );
});

test("release readiness checks tasks, dependent tasks, milestones, risks and publication checklist", async () => {
  const project = await make("project", "Release scope"),
    dependency = await make("task", "External dependency", {
      projectId: project.id,
      status: "todo",
    }),
    task = await make("task", "Release implementation", {
      projectId: project.id,
      status: "done",
      dependencies: [dependency.id],
    }),
    milestone = await draft("milestone", project, {
      delivery: { type: "milestone", taskIds: [task.id], dependsOn: [] },
    }),
    risk = await draft("risk", project),
    release = await draft("release", project, {
      delivery: {
        type: "release",
        version: "1.0.0",
        taskIds: [],
        milestoneIds: [milestone.id],
        riskIds: [risk.id],
        notes: "First public delivery",
        tag: "v1.0.0",
      },
      checklist: [{ id: "review", text: "Review deployment", done: false }],
    });
  let readiness = (
    await request("GET", base() + `/planning/${release.id}/readiness`)
  ).json();
  assert.equal(readiness.ready, false);
  assert.equal((await change(release, { status: "ready" })).statusCode, 400);
  assert.ok(readiness.issues.some((i: any) => i.id === dependency.id));
  assert.ok(readiness.issues.some((i: any) => i.id === milestone.id));
  assert.ok(readiness.issues.some((i: any) => i.id === risk.id));
  await edit(dependency, { status: "done" });
  assert.equal(
    (await confirm(milestone, await confirmation(milestone))).statusCode,
    200,
  );
  assert.equal(
    (await change(risk, { status: "accepted", assigneeId: ownerId }))
      .statusCode,
    400,
  );
  const acceptedRisk = await edit(risk, {
    status: "accepted",
    assigneeId: ownerId,
    delivery: {
      ...risk.data.delivery,
      dispositionReason: "Bounded impact accepted by owner",
      probability: 2,
      impact: 4,
    },
  });
  const checked = await edit(release, {
    checklist: [{ id: "review", text: "Review deployment", done: true }],
  });
  assert.equal((await change(checked, { status: "released" })).statusCode, 400);
  readiness = (
    await request("GET", base() + `/planning/${release.id}/readiness`)
  ).json();
  assert.equal(readiness.ready, true);
  const body = await confirmation(checked),
    response = await confirm(checked, body);
  assert.equal(response.statusCode, 200, response.body);
  const stored = await current(release.id),
    item = stored.data.deliveryReceipt.items.find((r: any) => r.id === risk.id);
  assert.equal(item.riskScore, 8);
  assert.ok(item.summary.includes("Bounded impact"));
  await edit(acceptedRisk, { status: "identified" });
  assert.equal(
    (await current(release.id)).data.deliveryReceipt.items.find(
      (r: any) => r.id === risk.id,
    ).status,
    "accepted",
  );
  assert.equal(
    (
      await change(stored, {
        delivery: { ...stored.data.delivery, version: "2.0.0" },
      })
    ).statusCode,
    409,
  );
});

test("confirmation rejects a stale task, project or risk version without partial publication", async () => {
  const project = await make("project", "Concurrent scope"),
    task = await make("task", "Concurrent task", {
      projectId: project.id,
      status: "done",
    }),
    milestone = await draft("milestone", project, {
      delivery: { type: "milestone", taskIds: [task.id], dependsOn: [] },
    }),
    body = await confirmation(milestone);
  await edit(task, { estimate: 8 });
  const response = await confirm(milestone, body);
  assert.equal(response.statusCode, 409);
  assert.equal((await current(milestone.id)).version, 1);
  assert.ok(!(await current(milestone.id)).data.deliveryReceipt);
  const next = await confirmation(milestone);
  await edit(project, { description: "A concurrent project edit" });
  assert.equal((await confirm(milestone, next)).statusCode, 409);
  assert.equal(
    (
      await confirm(milestone, {
        ...(await confirmation(milestone)),
        expectedReferences: [],
      })
    ).statusCode,
    409,
  );
});

test("decision acceptance documents alternatives and atomically supersedes an accepted decision", async () => {
  const project = await make("project", "Decision scope"),
    one = randomUUID(),
    two = randomUUID();
  const first = await draft("decision", project, {
    delivery: {
      type: "decision",
      options: [
        {
          id: one,
          label: "Modular application",
          tradeoffs: "Simple operations",
        },
        {
          id: two,
          label: "Independent services",
          tradeoffs: "More operational overhead",
        },
      ],
      chosenOptionId: one,
      rationale: "Small team and low resource requirements",
    },
  });
  assert.equal((await change(first, { status: "accepted" })).statusCode, 400);
  assert.equal(
    (await confirm(first, await confirmation(first))).statusCode,
    200,
  );
  const acceptedFirst = await current(first.id),
    newOption = randomUUID(),
    otherOption = randomUUID(),
    second = await draft("decision", project, {
      delivery: {
        type: "decision",
        options: [
          {
            id: newOption,
            label: "Revise module boundary",
            tradeoffs: "Measured change",
          },
          {
            id: otherOption,
            label: "Keep existing boundary",
            tradeoffs: "No migration",
          },
        ],
        chosenOptionId: newOption,
        rationale: "New operational evidence",
        supersedesId: first.id,
      },
    });
  const body = await confirmation(second),
    result = await confirm(second, body);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal((await current(first.id)).data.status, "superseded");
  assert.equal(
    (await current(first.id)).data.delivery.supersededById,
    second.id,
  );
  assert.deepEqual(
    (await current(first.id)).data.deliveryReceipt,
    acceptedFirst.data.deliveryReceipt,
  );
  assert.equal((await current(second.id)).data.status, "accepted");
  assert.equal((await confirm(await current(second.id), body)).statusCode, 200);
  const visible = (await request("GET", base() + "/resources")).json()
    .resources;
  assert.ok(visible.some((r: Resource) => r.id === first.id));
  assert.ok(visible.some((r: Resource) => r.id === second.id));
  assert.equal(
    (await change(await current(first.id), { status: "accepted" })).statusCode,
    409,
  );
});

test("historic private delivery scopes remain private after a source is made public", async () => {
  const project = await make("project", "Original private project", {
      private: true,
    }),
    task = await make("task", "Original private task", {
      projectId: project.id,
      status: "done",
    }),
    milestone = await draft("milestone", project, {
      delivery: { type: "milestone", taskIds: [task.id], dependsOn: [] },
    }),
    body = await confirmation(milestone);
  assert.equal((await confirm(milestone, body)).statusCode, 200);
  await edit(project, { private: false });
  const memberResources = (
    await request("GET", base() + "/resources", undefined, memberCookie)
  ).json().resources;
  assert.ok(memberResources.some((r: Resource) => r.id === task.id));
  assert.ok(!memberResources.some((r: Resource) => r.id === milestone.id));
  assert.equal(
    (
      await request(
        "GET",
        base() + `/resources/${milestone.id}/versions`,
        undefined,
        memberCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await confirm(await current(milestone.id), body, memberCookie)).statusCode,
    404,
  );
});

test("viewer writes, forged receipts, invalid choices and unresolved risks are rejected", async () => {
  const project = await make("project", "Validation scope"),
    risk = await draft("risk", project),
    decision = await draft("decision", project);
  assert.equal(
    (await change(risk, { status: "mitigating", assigneeId: ownerId }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await change(risk, {
        status: "resolved",
        delivery: { ...risk.data.delivery, mitigation: "Fixed" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await change(risk, {
        delivery: { ...risk.data.delivery, probability: 6 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await change(decision, {
        delivery: { ...decision.data.delivery, chosenOptionId: randomUUID() },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await confirm(decision, await confirmation(decision))).statusCode,
    409,
  );
  assert.equal(
    (await confirm(decision, await confirmation(decision), viewerCookie))
      .statusCode,
    403,
  );
  assert.equal(
    (await change(risk, { description: "Viewer write" }, viewerCookie))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await change(decision, {
        repository: "https://name:secret@example.test/repo",
      })
    ).statusCode,
    400,
  );
  const hiddenProject = await make("project", "Private responsibility", {
      private: true,
    }),
    hiddenRisk = await draft("risk", hiddenProject);
  assert.equal(
    (
      await change(hiddenRisk, {
        assigneeId: memberId,
        status: "accepted",
        delivery: {
          ...hiddenRisk.data.delivery,
          dispositionReason: "Reviewed",
        },
      })
    ).statusCode,
    400,
  );
});

test("shared milestone dependency graphs do not multiply permission work or bypass a private leaf", () => {
  const projectId = randomUUID(),
    creator = randomUUID(),
    reader = randomUUID(),
    graph: Resource[] = [];
  const base = (kind: Resource["kind"], data: any): Resource => ({
    id: randomUUID(),
    kind,
    workspace_id: workspaceId,
    title: "Permission graph",
    data,
    version: 1,
    created_by: creator,
    created_at: "",
    updated_at: "",
    deleted_at: null,
  });
  const project = { ...base("project", {}), id: projectId };
  graph.push(project);
  for (let index = 0; index < 60; index++)
    graph.push(
      base("milestone", {
        projectId,
        delivery: {
          type: "milestone",
          taskIds: [],
          dependsOn: graph
            .filter((r) => r.kind === "milestone")
            .slice(-2)
            .map((r) => r.id),
        },
      }),
    );
  let probes = 0;
  const observed = new Proxy(graph, {
    get(target, key, receiver) {
      if (key === "find")
        return (...args: any[]) => {
          probes++;
          return (target.find as any).apply(target, args);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(
    canRead(graph[graph.length - 1], reader, "member", observed),
    true,
  );
  assert.ok(
    probes < 1000,
    "Shared dependencies must be evaluated without exponential expansion",
  );
  project.data.private = true;
  assert.equal(
    canRead(graph[graph.length - 1], reader, "member", observed),
    false,
  );
});
