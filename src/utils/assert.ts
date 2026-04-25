import { badRequest } from "./http-error";

export function assert(
  condition: unknown,
  message = "Assertion failed",
  details?: unknown,
): asserts condition {
  if (!condition) {
    throw badRequest(message, details);
  }
}
