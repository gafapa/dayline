export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public extra?: unknown,
  ) {
    super(message);
  }
}
