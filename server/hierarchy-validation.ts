import type { Resource } from "../shared/model.js";
import {
  acceptsChild,
  isStructure,
  projectAt,
  structureBranch,
  structurePath,
} from "../shared/hierarchy.js";
import { HttpError } from "./errors.js";
export function validateHierarchyMutation(
  proposed: Resource,
  existing: Resource | undefined,
  all: Resource[],
  moving = false,
) {
  if (!isStructure(proposed)) return;
  const graph = [...all.filter((r) => r.id !== proposed.id), proposed];
  try {
    structurePath(proposed.id, graph);
    if (proposed.data.parentId) {
      const parent = graph.find((r) => r.id === proposed.data.parentId);
      if (
        !parent ||
        parent.deleted_at ||
        parent.data.archived ||
        !acceptsChild(parent.kind, proposed.kind)
      )
        throw new HttpError(
          400,
          "La ubicación no admite este tipo de elemento.",
        );
      if (
        proposed.kind !== "project" &&
        (proposed.data.projectId || null) !== projectAt(parent.id, graph)
      )
        throw new HttpError(
          400,
          "El proyecto debe coincidir con la ubicación.",
        );
    }
    if (proposed.kind === "project" && proposed.data.projectId)
      throw new HttpError(
        400,
        "Los subproyectos usan su proyecto o carpeta superior.",
      );
    if (
      proposed.kind === "folder" &&
      (proposed.data.ownerId ||
        proposed.data.private ||
        proposed.data.members?.length)
    )
      throw new HttpError(
        400,
        "La carpeta hereda los permisos de su ubicación.",
      );
    if (
      existing &&
      !moving &&
      ((existing.data.parentId || null) !== (proposed.data.parentId || null) ||
        (existing.data.projectId || null) !==
          (proposed.data.projectId || null)) &&
      structureBranch(existing.id, all).length > 1
    )
      throw new HttpError(
        409,
        "Esta estructura tiene contenido. Usa Mover para revisar el cambio completo.",
      );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "La estructura no es válida.",
    );
  }
}
