import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

const API_SECRET_TOKEN = process.env.API_SECRET_TOKEN ?? "";

if (!API_SECRET_TOKEN) {
  logger.warn(
    "API_SECRET_TOKEN is not set — /api/admins and /api/stats routes are UNPROTECTED. " +
      "Set this environment variable to secure the REST API.",
  );
}

/**
 * Middleware that protects routes with a bearer token.
 *
 * Accepts the token via:
 *   Authorization: Bearer <token>
 *   x-api-key: <token>
 *
 * If API_SECRET_TOKEN is not configured, all requests are rejected (fail-closed).
 */
export function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  // Fail-closed: if no token is configured, block all access
  if (!API_SECRET_TOKEN) {
    res.status(503).json({
      error: "API authentication is not configured on this server.",
    });
    return;
  }

  const authHeader = req.headers["authorization"];
  const apiKeyHeader = req.headers["x-api-key"];

  let providedToken: string | null = null;

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    providedToken = authHeader.slice(7).trim();
  } else if (typeof apiKeyHeader === "string") {
    providedToken = apiKeyHeader.trim();
  }

  if (!providedToken || providedToken !== API_SECRET_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
