import { randomUUID } from "node:crypto";
import type { Connection } from "./database.js";
import type { Mutation, Resource } from "../shared/model.js";
import { HttpError } from "./errors.js";

/**
 * Team work always belongs to a project. Tasks, and team documents that do not live in the
 * folder structure, without a project go to the workspace's "General" project.
 */
export const needsProject = (kind: string, data: Record<string, any>) =>
  (kind === "task" && !data.projectId) ||
  (kind === "document" && !data.projectId && !data.parentId && !data.personalNote);

/** The workspace's General project, created on first use. */
export async function generalProject(
  tx: Connection,
  workspaceId: string,
  createdBy: string,
): Promise<string> {
  // One General project per workspace, even with concurrent first uses.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`general:${workspaceId}`]);
  const existing = (
    await tx.query<{ id: string }>(
      "SELECT id FROM resources WHERE workspace_id=$1 AND kind='project' AND deleted_at IS NULL AND data->>'general'='true' ORDER BY created_at LIMIT 1",
      [workspaceId],
    )
  ).rows[0];
  if (existing) return existing.id;
  const id = randomUUID();
  await tx.query(
    "INSERT INTO resources(id,workspace_id,kind,title,data,created_by) VALUES($1,$2,'project','General',$3,$4)",
    [
      id,
      workspaceId,
      JSON.stringify({
        status: "active",
        general: true,
        description: "Tareas y documentos que no pertenecen a otro proyecto.",
      }),
      createdBy,
    ],
  );
  return id;
}

/** Fills in the General project for team work that arrives without one. */
export async function assignGeneralProject(
  tx: Connection,
  workspaceId: string,
  userId: string,
  input: Mutation,
) {
  if (input.deleted) return input;
  // A document inside another item takes that item's project.
  if (input.kind === "document" && !input.data.projectId && input.data.parentId && !input.data.personalNote) {
    const parent = (
      await tx.query<{ kind: string; id: string; project: string | null }>(
        "SELECT kind,id,data->>'projectId' AS project FROM resources WHERE id=$1 AND workspace_id=$2",
        [input.data.parentId, workspaceId],
      )
    ).rows[0];
    const projectId = parent?.kind === "project" ? parent.id : parent?.project;
    if (projectId) return { ...input, data: { ...input.data, projectId } };
  }
  if (!needsProject(input.kind, input.data)) return input;
  return {
    ...input,
    data: { ...input.data, projectId: await generalProject(tx, workspaceId, userId) },
  };
}

/** The General project can be renamed, but not removed or archived. */
export function protectGeneralProject(existing: Resource | undefined, input: Mutation) {
  if (existing?.kind === "project" && existing.data.general && (input.deleted || input.data.archived))
    throw new HttpError(409, "El proyecto General no se puede eliminar ni archivar.");
}

/** Migration: moves existing team work without a project into each workspace's General. */
export async function migrateToGeneralProjects(tx: Connection) {
  const orphans = (
    await tx.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id FROM resources WHERE deleted_at IS NULL AND coalesce(data->>'projectId','')='' AND (
         kind='task' OR (kind='document' AND coalesce(data->>'parentId','')='' AND coalesce(data->>'personalNote','false')<>'true'))`,
    )
  ).rows;
  for (const { workspace_id } of orphans) {
    const owner = (
      await tx.query<{ user_id: string }>(
        "SELECT user_id FROM memberships WHERE workspace_id=$1 ORDER BY (role='admin') DESC LIMIT 1",
        [workspace_id],
      )
    ).rows[0];
    if (!owner) continue;
    const general = await generalProject(tx, workspace_id, owner.user_id);
    await tx.query(
      `UPDATE resources SET data=jsonb_set(data,'{projectId}',to_jsonb($2::text)) WHERE workspace_id=$1 AND deleted_at IS NULL AND coalesce(data->>'projectId','')='' AND (
         kind='task' OR (kind='document' AND coalesce(data->>'parentId','')='' AND coalesce(data->>'personalNote','false')<>'true'))`,
      [workspace_id, general],
    );
  }
}
