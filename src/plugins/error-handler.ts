import type { FastifyInstance } from "fastify";
import { HttpError } from "../utils/http-error";
import { sendError } from "../utils/response";

export function registerErrorHandlers(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    return sendError(reply, {
      status: 404,
      message: `Route ${request.method}:${request.url} not found`,
      errorCode: "ROUTE_NOT_FOUND",
    });
  });

  app.setErrorHandler((error: any, request, reply) => {
    request.log.error(error);

    const err = error as any;
    const isValidationError = err.validation || err.code === "FST_ERR_VALIDATION";

    if (isValidationError) {
      return sendError(reply, {
        status: 400,
        message: err.message || "Validation error",
        errorCode: "VALIDATION_ERROR",
        data: {
          validation: err.validation ?? null,
        },
      });
    }

    if (err instanceof HttpError) {
      return sendError(reply, {
        status: err.statusCode,
        message: err.message,
        errorCode: err.errorCode,
        data: err.details ?? null,
      });
    }

    const statusCode = err.statusCode && Number(err.statusCode) >= 400
      ? Number(err.statusCode)
      : 500;

    if (statusCode >= 500) {
      return sendError(reply, {
        status: 500,
        message: "Internal server error",
        errorCode: "INTERNAL_SERVER_ERROR",
      });
    }

    return sendError(reply, {
      status: statusCode,
      message: err.message || "Request failed",
      errorCode: err.code || "REQUEST_ERROR",
    });
  });
}
