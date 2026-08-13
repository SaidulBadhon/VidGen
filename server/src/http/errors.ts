/**
 * HTTP error type and handlers.
 * Ported from python-version/app/models/exception.py + app/asgi.py.
 */

import type { Context } from "hono";
import { ZodError } from "zod";
import { logger } from "../utils/logger.ts";
import { getResponse } from "../utils/misc.ts";

export class HttpException extends Error {
  readonly statusCode: number;
  readonly taskId: string;
  readonly data: unknown;

  constructor(options: { taskId?: string; statusCode: number; message: string; data?: unknown }) {
    super(options.message);
    this.name = "HttpException";
    this.statusCode = options.statusCode;
    this.taskId = options.taskId ?? "";
    this.data = options.data;
  }
}

export function notFound(message: string, taskId = ""): HttpException {
  return new HttpException({ taskId, statusCode: 404, message });
}

export function badRequest(message: string, taskId = ""): HttpException {
  return new HttpException({ taskId, statusCode: 400, message });
}

export function conflict(message: string, taskId = ""): HttpException {
  return new HttpException({ taskId, statusCode: 409, message });
}

export function tooManyRequests(message: string, taskId = ""): HttpException {
  return new HttpException({ taskId, statusCode: 429, message });
}

/**
 * Single error handler for the app.
 *
 * Validation failures return 400 with the field errors, matching the FastAPI
 * `RequestValidationError` shape the existing clients and CLI expect.
 */
export function handleError(error: Error, c: Context): Response {
  if (error instanceof HttpException) {
    return c.json(getResponse(error.statusCode, error.data, error.message), error.statusCode as 400);
  }

  if (error instanceof ZodError) {
    return c.json(getResponse(400, error.issues, "field required"), 400);
  }

  logger.exception(`unhandled request error: ${c.req.method} ${c.req.path}`, error);
  return c.json(getResponse(500, undefined, error.message || "internal server error"), 500);
}
