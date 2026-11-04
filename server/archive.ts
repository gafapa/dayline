import { Readable } from "node:stream";
import { DOCUMENT_SCHEMA_VERSION } from "../shared/document-protocol.js";
import { createGzip } from "node:zlib";
import type { Database } from "./database.js";
import type { Resource } from "../shared/model.js";

export function tarHeader(name: string, size: number) {
  if (!/^[a-zA-Z0-9._/-]{1,100}$/.test(name) || name.includes(".."))
    throw new Error("Invalid archive entry");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  const octal = (value: number, length: number) =>
    value.toString(8).padStart(length - 1, "0") + "\0";
  header.write(octal(0o600, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(size, 12), 124);
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}
export function workspaceArchive(
  db: Database,
  resources: Resource[],
  attachments: any[],
  workspaceId: string,
) {
  async function* entry(name: string, body: Buffer) {
    yield tarHeader(name, body.length);
    yield body;
    if (body.length % 512) yield Buffer.alloc(512 - (body.length % 512));
  }
  async function* archive() {
    const manifest = {
      format: "kelvin-workspace-archive",
      documentSchemaVersion: DOCUMENT_SCHEMA_VERSION,
      version: 1,
      exportedAt: new Date().toISOString(),
      resources,
      attachments: attachments.map((a) => ({
        ...a,
        path: `attachments/${a.id}`,
      })),
    };
    yield* entry(
      "workspace.json",
      Buffer.from(JSON.stringify(manifest, null, 2)),
    );
    for (const document of resources.filter((r) => r.kind === "document")) {
      const state = (
        await db.query(
          "SELECT state FROM document_states WHERE resource_id=$1",
          [document.id],
        )
      ).rows[0]?.state;
      if (state)
        yield* entry(`document-states/${document.id}.bin`, Buffer.from(state));
    }
    for (const attachment of attachments) {
      const row = (
        await db.query(
          "SELECT body FROM attachments WHERE id=$1 AND workspace_id=$2",
          [attachment.id, workspaceId],
        )
      ).rows[0];
      if (!row) throw new Error("Attachment unavailable during export");
      yield* entry(`attachments/${attachment.id}`, Buffer.from(row.body));
    }
    yield Buffer.alloc(1024);
  }
  return Readable.from(archive()).pipe(createGzip({ level: 3 }));
}
