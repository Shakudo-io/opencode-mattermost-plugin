/**
 * MS Teams Bot Server
 *
 * Express.js server that handles incoming Bot Framework messages from MS Teams.
 * Provides:
 * - POST /api/messages - Bot Framework messaging endpoint
 * - GET /api/health - Health check endpoint for Kubernetes probes
 *
 * Uses CloudAdapter for token validation and message processing.
 */

import express, { Request, Response, NextFunction } from "express";
import { CloudAdapter, ActivityHandler } from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import { getTeamsConfig, type TeamsConfig } from "./teams-config.js";

// =============================================================================
// Types
// =============================================================================

export interface TeamsServerOptions {
  /** CloudAdapter instance for processing messages */
  adapter: CloudAdapter;
  /** Bot activity handler */
  bot: ActivityHandler;
  /** Optional config override (uses getTeamsConfig() if not provided) */
  config?: TeamsConfig;
}

export interface TeamsServer {
  /** Express application instance */
  app: express.Application;
  /** Start the server */
  start: () => Promise<void>;
  /** Stop the server */
  stop: () => Promise<void>;
  /** Server port */
  port: number;
}

// =============================================================================
// Server Factory
// =============================================================================

/**
 * Create and configure the MS Teams bot server
 *
 * @param options Server configuration options
 * @returns TeamsServer instance
 */
export function createTeamsServer(options: TeamsServerOptions): TeamsServer {
  const log = teamsLog.withContext("TeamsServer");
  log.debug("createTeamsServer entry");
  const { adapter, bot, config: configOverride } = options;
  const config = configOverride ?? getTeamsConfig();

  const app = express();

  // Track server instance for graceful shutdown
  let serverInstance: ReturnType<typeof app.listen> | null = null;

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  // Parse JSON bodies (required for Bot Framework messages)
  app.use(express.json());

  const sanitizeHeaders = (headers: Request["headers"]): Record<string, unknown> => {
    const sanitized: Record<string, unknown> = { ...headers };
    if (sanitized.authorization) {
      sanitized.authorization = "[REDACTED]";
    }
    if (sanitized.Authorization) {
      sanitized.Authorization = "[REDACTED]";
    }
    return sanitized;
  };

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    log.info("Incoming request", {
      method: req.method,
      path: req.path,
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // Health Check Endpoint (T027)
  // ---------------------------------------------------------------------------

  const healthPath = `${config.server.basePath}${config.server.healthPath}`;

  app.get(healthPath, (_req: Request, res: Response) => {
    const healthResponse = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      service: "opencode-teams-bot",
      version: "1.0.0",
    };

    log.info("Health check", { response: healthResponse });
    res.status(200).json(healthResponse);
  });

  // ---------------------------------------------------------------------------
  // Bot Framework Messages Endpoint (T026)
  // ---------------------------------------------------------------------------

  const messagesPath = `${config.server.basePath}${config.server.messagesPath}`;

  app.post(messagesPath, async (req: Request, res: Response) => {
    log.info("Incoming message", {
      path: messagesPath,
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
    });

    try {
      // Validate request has required Bot Framework headers
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        log.warn("Missing Authorization header");
        // Don't return 401 here - let the adapter handle token validation
        // Some probing tools send requests without auth
      }

      // Log activity type for debugging
      const activityType = req.body?.type;
      log.debug(`Activity type: ${activityType}`);

      // Process the incoming activity through the adapter
      // The adapter handles:
      // - Token validation (returns 401 if invalid)
      // - Activity parsing
      // - Routing to bot handler
      await adapter.process(req, res, async (context) => {
        await bot.run(context);
      });
    } catch (error) {
      // Handle errors that escape the adapter (T029)
      log.error("Error processing message", {
        error: String(error),
        path: req.path,
        method: req.method,
        headers: sanitizeHeaders(req.headers),
      });

      // Don't send response if headers already sent
      if (!res.headersSent) {
        if (error instanceof Error) {
          // Check for specific error types
          if (error.message.includes("Unauthorized") || error.message.includes("401")) {
            res.status(401).json({
              error: "Unauthorized",
              message: "Invalid or missing authentication token",
            });
          } else if (error.message.includes("BadRequest") || error.message.includes("400")) {
            res.status(400).json({
              error: "Bad Request",
              message: "Malformed request body",
            });
          } else {
            res.status(500).json({
              error: "Internal Server Error",
              message: "An unexpected error occurred",
            });
          }
        } else {
          res.status(500).json({
            error: "Internal Server Error",
            message: "An unexpected error occurred",
          });
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Error Handling Middleware (T029)
  // ---------------------------------------------------------------------------

  // 404 handler for unknown routes
  app.use((req: Request, res: Response) => {
    log.warn("Route not found", { path: req.path, method: req.method });
    res.status(404).json({
      error: "Not Found",
      message: "The requested endpoint does not exist",
    });
  });

  // Global error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    log.error("Unhandled error", {
      message: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
      headers: sanitizeHeaders(req.headers),
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: "Internal Server Error",
        message: "An unexpected error occurred",
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Server Lifecycle
  // ---------------------------------------------------------------------------

  const port = config.server.port;

  const start = (): Promise<void> => {
    log.debug("start entry");
    return new Promise((resolve, reject) => {
      try {
        serverInstance = app.listen(port, () => {
          log.info(`MS Teams bot server started on port ${port}`);
          log.info(`Health endpoint: http://localhost:${port}${healthPath}`);
          log.info(`Messages endpoint: http://localhost:${port}${messagesPath}`);
          log.debug("start exit: listening");
          resolve();
        });

        serverInstance.on("error", (error) => {
          log.error(`Server error: ${error}`);
          log.debug("start exit: error");
          reject(error);
        });
      } catch (error) {
        log.error(`Server start failed: ${error}`);
        log.debug("start exit: exception");
        reject(error);
      }
    });
  };

  const stop = (): Promise<void> => {
    log.debug("stop entry");
    return new Promise((resolve) => {
      if (serverInstance) {
        log.info("Stopping MS Teams bot server...");
        serverInstance.close(() => {
          log.info("MS Teams bot server stopped");
          serverInstance = null;
          log.debug("stop exit: stopped");
          resolve();
        });
      } else {
        log.debug("stop exit: no server instance");
        resolve();
      }
    });
  };

  log.debug("createTeamsServer exit");
  return {
    app,
    start,
    stop,
    port,
  };
}

// =============================================================================
// Exports
// =============================================================================

export type { Request, Response } from "express";
