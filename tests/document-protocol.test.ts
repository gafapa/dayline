import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { getSchema } from "@tiptap/core";
import { documentExtensions } from "../shared/editor-schema";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import {
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SCHEMA_HEADER,
} from "../shared/document-protocol";
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
  workspaceId: string;
const request = (
  method: any,
  url: string,
  payload?: any,
  schema: string | undefined = "1",
) =>
  api.app.inject({
    method,
    url,
    payload,
    headers: {
      origin: "http://test.local",
      "x-kelvin-client": "web",
      ...(cookie ? { cookie } : {}),
      ...(schema === undefined ? {} : { [DOCUMENT_SCHEMA_HEADER]: schema }),
    },
  });
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, {
    origin: "http://test.local",
    setupToken: "protocol-setup",
    encryptionKey: "ab".repeat(32),
  });
  const setup = await request("POST", "/api/setup", {
    email: "protocol@example.test",
    password: "protocol-test-password-long",
    name: "Protocol owner",
    workspaceName: "Protocol tests",
    setupToken: "protocol-setup",
  });
  assert.equal(setup.statusCode, 200, setup.body);
  cookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  workspaceId = (await request("GET", "/api/me")).json().workspaces[0].id;
});
after(async () => {
  await api.app.close();
  await db.close();
});
const mutation = (patch: any = {}) => ({
  id: randomUUID(),
  operationId: randomUUID(),
  kind: "document",
  title: "Compatible document",
  data: {
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Keep original" }],
        },
      ],
    },
  },
  expectedVersion: 0,
  ...patch,
});
test("stale and unversioned document writers cannot create documents or operation receipts", async () => {
  for (const schema of ["0", "2", "01", "1.0"]) {
    const input = mutation(),
      result = await request(
        "POST",
        `/api/workspaces/${workspaceId}/mutate`,
        input,
        schema,
      );
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.json().detail.code, "document_schema_mismatch");
    assert.equal(
      (
        await db.query("SELECT id FROM operations WHERE id=$1", [
          input.operationId,
        ])
      ).rows.length,
      0,
    );
  }
  const input = mutation(),
    missing = await api.app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/mutate`,
      payload: input,
      headers: { "x-kelvin-client": "web", cookie },
    });
  assert.equal(missing.statusCode, 409);
});
test("compatible writes record their format and reject a falsely labelled future payload without changing content", async () => {
  const input = mutation(),
    created = await request(
      "POST",
      `/api/workspaces/${workspaceId}/mutate`,
      input,
    );
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(
    created.json().resource.data.documentSchemaVersion,
    DOCUMENT_SCHEMA_VERSION,
  );
  const edit = mutation({
      id: input.id,
      expectedVersion: 1,
      data: { documentSchemaVersion: 2, content: { type: "doc", content: [] } },
    }),
    result = await request(
      "POST",
      `/api/workspaces/${workspaceId}/mutate`,
      edit,
    );
  assert.equal(result.statusCode, 409, result.body);
  const stored = (
    await db.query("SELECT data,version FROM resources WHERE id=$1", [input.id])
  ).rows[0];
  assert.equal(stored.version, 1);
  assert.equal(stored.data.content.content[0].content[0].text, "Keep original");
  for (const suffix of ["state", "revisions"])
    assert.equal(
      (
        await request(
          "GET",
          `/api/workspaces/${workspaceId}/documents/${input.id}/${suffix}`,
          undefined,
          "2",
        )
      ).statusCode,
      409,
    );
  assert.equal(
    (
      await request(
        "GET",
        `/api/workspaces/${workspaceId}/documents/${input.id}/state`,
      )
    ).statusCode,
    200,
  );
});
test("database startup refuses unsupported stored formats and preserves document rows", async () => {
  const before = (
    await db.query("SELECT id,data,version FROM resources ORDER BY id")
  ).rows;
  await db.query("UPDATE document_format SET version=2 WHERE id=1");
  await assert.rejects(migrate(db), /schema migration required/);
  assert.equal(
    (await db.query("SELECT version FROM document_format WHERE id=1")).rows[0]
      .version,
    2,
  );
  assert.deepEqual(
    (await db.query("SELECT id,data,version FROM resources ORDER BY id")).rows,
    before,
  );
  await db.query("UPDATE document_format SET version=1 WHERE id=1");
  await migrate(db);
});
test("health and API responses advertise the effective document format", async () => {
  const result = await request("GET", "/api/health");
  assert.equal(result.json().documentSchemaVersion, DOCUMENT_SCHEMA_VERSION);
  assert.equal(result.headers[DOCUMENT_SCHEMA_HEADER.toLowerCase()], "1");
});

test("document schema changes require a reviewed protocol version and migration", () => {
  const schema = getSchema(documentExtensions());
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({ nodes: schema.spec.nodes, marks: schema.spec.marks }),
    )
    .digest("hex");
  const reviewedFormats: Record<number, string> = {
    1: "1f1c99fc144957539e17ded09faa200341ddae6b6f90c5b9bd3bdd3953518a93",
  };
  assert.equal(
    fingerprint,
    reviewedFormats[DOCUMENT_SCHEMA_VERSION],
    "Review compatibility, increment DOCUMENT_SCHEMA_VERSION and implement an explicit migration before changing the editor schema.",
  );
});

test("unknown document nodes and attributes are rejected before a resource or receipt is written", async () => {
  for (const content of [
    { type: "doc", content: [{ type: "futureBlock" }] },
    {
      type: "doc",
      content: [{ type: "paragraph", attrs: { futureMeaning: "keep" } }],
    },
  ]) {
    const input = mutation({ data: { content } }),
      result = await request(
        "POST",
        `/api/workspaces/${workspaceId}/mutate`,
        input,
      );
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().detail.code, "invalid_document_content");
    assert.equal(
      (await db.query("SELECT id FROM resources WHERE id=$1", [input.id])).rows
        .length,
      0,
    );
    assert.equal(
      (
        await db.query("SELECT id FROM operations WHERE id=$1", [
          input.operationId,
        ])
      ).rows.length,
      0,
    );
  }
});
