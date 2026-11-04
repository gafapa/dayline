import { assertLocalSession, trackRequest } from "./local-lifecycle";
import {
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SCHEMA_HEADER,
  DOCUMENT_SCHEMA_EVENT,
  DOCUMENT_SCHEMA_MESSAGE,
  compatibleDocumentSchema,
} from "../shared/document-protocol";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  init: RequestInit = {},
  retryRead = true,
): Promise<T> {
  if (path !== "/logout") assertLocalSession();
  const done = trackRequest();
  try {
    return await request<T>(path, init, retryRead);
  } finally {
    done();
  }
}
async function request<T>(
  path: string,
  init: RequestInit,
  retryRead: boolean,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Kelvin-Client": "web",
      [DOCUMENT_SCHEMA_HEADER]: String(DOCUMENT_SCHEMA_VERSION),
      ...init.headers,
    },
  });
  const schema = response.headers.get(DOCUMENT_SCHEMA_HEADER);
  if (schema !== null && !compatibleDocumentSchema(schema)) {
    window.dispatchEvent(new Event(DOCUMENT_SCHEMA_EVENT));
    throw new ApiError(409, DOCUMENT_SCHEMA_MESSAGE, {
      code: "document_schema_mismatch",
    });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok && body.detail?.code === "document_schema_mismatch")
    window.dispatchEvent(new Event(DOCUMENT_SCHEMA_EVENT));
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (
    response.status === 429 &&
    (init.method || "GET").toUpperCase() === "GET" &&
    retryRead &&
    Number.isInteger(retryAfter) &&
    retryAfter > 0 &&
    retryAfter <= 60
  ) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", abort);
        reject(new DOMException("Request cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        init.signal?.removeEventListener("abort", abort);
        resolve();
      }, retryAfter * 1000);
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
    return api<T>(path, init, false);
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      body.error || "No se pudo conectar con el servidor.",
      body.detail,
    );
  return body;
}
export const send = (body: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
