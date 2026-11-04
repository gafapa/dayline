import { getSchema } from "@tiptap/core";
import { documentExtensions } from "../shared/editor-schema.js";
import { assertDocumentContent } from "../shared/document-content.js";
import { HttpError } from "./errors.js";
export const documentSchema = getSchema(documentExtensions());
export function validateDocumentContent(content: unknown) {
  try {
    assertDocumentContent(documentSchema, content);
  } catch {
    throw new HttpError(
      400,
      "El contenido usa bloques o atributos que este editor no reconoce. Los datos guardados se conservan.",
      { code: "invalid_document_content" },
    );
  }
}
