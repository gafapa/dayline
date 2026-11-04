import type { Resource } from "../shared/model.js";
import { HttpError } from "./errors.js";

export function validatePersonalNote(
  proposed: Resource,
  previous: Resource | undefined,
  all: Resource[],
  userId: string,
) {
  if (proposed.kind !== "document" && proposed.data.personalNote !== undefined)
    throw new HttpError(
      400,
      "La marca personal pertenece a una nota de documento.",
    );
  if (previous && !previous.data.personalNote && proposed.data.personalNote)
    throw new HttpError(
      400,
      "Crea una nota personal nueva para conservar separado el documento original.",
    );
  if (
    previous?.data.personalNote &&
    (!proposed.data.personalNote ||
      proposed.data.ownerId !== previous.data.ownerId)
  )
    throw new HttpError(
      403,
      "Una nota personal conserva su propietario y su privacidad.",
    );
  if (proposed.data.personalNote) {
    if (
      proposed.created_by !== userId ||
      (proposed.data.ownerId && proposed.data.ownerId !== userId)
    )
      throw new HttpError(403, "La nota personal pertenece a su autor.");
    if (
      proposed.data.projectId ||
      proposed.data.parentId ||
      proposed.data.targetId
    )
      throw new HttpError(
        400,
        "Las notas personales se organizan fuera de las carpetas y los proyectos compartidos.",
      );
    proposed.data.ownerId = userId;
  }
  if (
    proposed.data.parentId &&
    all.some(
      (item) =>
        item.id === proposed.data.parentId &&
        item.data.personalNote &&
        item.data.ownerId === userId,
    )
  )
    throw new HttpError(
      400,
      "Una nota personal no contiene otros elementos. Utiliza un enlace dentro de su texto.",
    );
}
