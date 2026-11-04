export const DOCUMENT_SCHEMA_VERSION = 1;
export const DOCUMENT_SEED_VERSION = 1;
export const DOCUMENT_SCHEMA_HEADER = "X-Kelvin-Document-Schema";
export const DOCUMENT_SCHEMA_EVENT = "kelvin:document-schema-mismatch";
export const DOCUMENT_SCHEMA_MESSAGE =
  "Esta versión del editor no es compatible con el documento. Actualiza la aplicación; tu copia local se conserva.";
export const compatibleDocumentSchema = (version: unknown) =>
  version === DOCUMENT_SCHEMA_VERSION ||
  version === String(DOCUMENT_SCHEMA_VERSION);
