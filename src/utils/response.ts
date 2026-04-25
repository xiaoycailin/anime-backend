import type { FastifyReply } from "fastify";

type ResponseMeta = Record<string, unknown>;

type ResponseOptions<T = unknown, M extends ResponseMeta = ResponseMeta> = {
  status?: number;
  message?: string;
  data?: T;
  meta?: M | null;
  errorCode?: string | null;
};

type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

function buildMeta<M extends ResponseMeta = ResponseMeta>(
  reply: FastifyReply,
  meta?: M | null,
) {
  return {
    requestId: reply.request.id,
    ...(meta ?? {}),
  };
}

export function sendResponse<
  T = unknown,
  M extends ResponseMeta = ResponseMeta,
>(reply: FastifyReply, options: ResponseOptions<T, M> = {}) {
  const status = options.status ?? 200;

  return reply.status(status).send({
    status,
    message: options.message ?? null,
    errorCode: options.errorCode ?? null,
    duration: `${reply.elapsedTime.toFixed(2)}ms`,
    data: options.data ?? null,
    meta: buildMeta(reply, options.meta),
  });
}

export function ok<T = unknown, M extends ResponseMeta = ResponseMeta>(
  reply: FastifyReply,
  options: Omit<ResponseOptions<T, M>, "status" | "errorCode"> = {},
) {
  return sendResponse(reply, {
    status: 200,
    message: options.message ?? "Success",
    data: options.data,
    meta: options.meta,
  });
}

export function created<T = unknown, M extends ResponseMeta = ResponseMeta>(
  reply: FastifyReply,
  options: Omit<ResponseOptions<T, M>, "status" | "errorCode"> = {},
) {
  return sendResponse(reply, {
    status: 201,
    message: options.message ?? "Created successfully",
    data: options.data,
    meta: options.meta,
  });
}

export function noContent(reply: FastifyReply) {
  return reply.status(204).send();
}

export function paginated<T = unknown>(
  reply: FastifyReply,
  options: {
    items: T[];
    page: number;
    limit: number;
    total: number;
    message?: string;
    meta?: ResponseMeta | null;
  },
) {
  const paginationMeta: PaginationMeta = {
    page: options.page,
    limit: options.limit,
    total: options.total,
    totalPages: Math.ceil(options.total / options.limit),
  };

  return ok(reply, {
    message: options.message ?? "Data fetched successfully",
    data: options.items,
    meta: {
      ...paginationMeta,
      ...(options.meta ?? {}),
    },
  });
}

export function sendError<M extends ResponseMeta = ResponseMeta>(
  reply: FastifyReply,
  options: {
    status?: number;
    message?: string;
    errorCode?: string;
    data?: unknown;
    meta?: M | null;
  } = {},
) {
  return sendResponse(reply, {
    status: options.status ?? 500,
    message: options.message ?? "Internal server error",
    errorCode: options.errorCode ?? "INTERNAL_SERVER_ERROR",
    data: options.data ?? null,
    meta: options.meta ?? null,
  });
}
