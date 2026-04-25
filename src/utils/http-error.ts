export class HttpError extends Error {
  statusCode: number;
  errorCode: string;
  details?: unknown;

  constructor(
    statusCode: number,
    message: string,
    errorCode = "HTTP_ERROR",
    details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

export function badRequest(message = "Bad request", details?: unknown) {
  return new HttpError(400, message, "BAD_REQUEST", details);
}

export function unauthorized(message = "Unauthorized", details?: unknown) {
  return new HttpError(401, message, "UNAUTHORIZED", details);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, "FORBIDDEN", details);
}

export function notFound(message = "Not found", details?: unknown) {
  return new HttpError(404, message, "NOT_FOUND", details);
}

export function conflict(message = "Conflict", details?: unknown) {
  return new HttpError(409, message, "CONFLICT", details);
}

export function unprocessable(message = "Unprocessable entity", details?: unknown) {
  return new HttpError(422, message, "UNPROCESSABLE_ENTITY", details);
}
