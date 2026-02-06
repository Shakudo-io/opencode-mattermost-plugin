import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { getTeamsConfig } from "./teams-config.js";

const getLogFile = (): string => {
  try {
    return getTeamsConfig().logging.logFile;
  } catch {
    return "/tmp/opencode-teams-plugin.log";
  }
};

function ensureLogDir(logFile: string): void {
  const dir = dirname(logFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function serializeArg(arg: unknown): string {
  if (arg === null || arg === undefined) {
    return String(arg);
  }

  if (arg instanceof Error) {
    const errorObj: Record<string, unknown> = {
      message: arg.message,
      name: arg.name,
    };

    const axiosError = arg as {
      response?: { status?: number; data?: unknown };
      code?: string;
      config?: { url?: string; method?: string };
    };
    if (axiosError.response) {
      errorObj.status = axiosError.response.status;
      errorObj.responseData = axiosError.response.data;
    }
    if (axiosError.code) {
      errorObj.code = axiosError.code;
    }
    if (axiosError.config) {
      errorObj.url = axiosError.config.url;
      errorObj.method = axiosError.config.method;
    }

    return JSON.stringify(errorObj);
  }

  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  return String(arg);
}

function writeLog(level: string, context: string, message: string, ...args: unknown[]): void {
  try {
    const logFile = getLogFile();
    ensureLogDir(logFile);
    const formattedArgs = args.length > 0 ? " " + args.map(serializeArg).join(" ") : "";
    const contextPrefix = context ? `[${context}] ` : "";
    const line = `[${formatTimestamp()}] [TEAMS] [${level}] ${contextPrefix}${message}${formattedArgs}\n`;
    appendFileSync(logFile, line);
  } catch {}
}

export interface TeamsLogger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  withContext: (context: string) => TeamsLogger;
}

function createLoggerWithContext(context: string): TeamsLogger {
  return {
    debug: (message: string, ...args: unknown[]) => writeLog("DEBUG", context, message, ...args),
    info: (message: string, ...args: unknown[]) => writeLog("INFO", context, message, ...args),
    warn: (message: string, ...args: unknown[]) => writeLog("WARN", context, message, ...args),
    error: (message: string, ...args: unknown[]) => writeLog("ERROR", context, message, ...args),
    withContext: (newContext: string) => createLoggerWithContext(`${context}:${newContext}`),
  };
}

export const teamsLog: TeamsLogger = {
  debug: (message: string, ...args: unknown[]) => writeLog("DEBUG", "", message, ...args),
  info: (message: string, ...args: unknown[]) => writeLog("INFO", "", message, ...args),
  warn: (message: string, ...args: unknown[]) => writeLog("WARN", "", message, ...args),
  error: (message: string, ...args: unknown[]) => writeLog("ERROR", "", message, ...args),
  withContext: (context: string) => createLoggerWithContext(context),
};
