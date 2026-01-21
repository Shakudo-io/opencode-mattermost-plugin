import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const LOG_FILE = process.env.MM_PLUGIN_LOG_FILE || "/tmp/opencode-mattermost-plugin.log";

function ensureLogDir(): void {
  const dir = dirname(LOG_FILE);
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
  
  // Handle Error objects specially (including Axios errors)
  if (arg instanceof Error) {
    const errorObj: Record<string, unknown> = {
      message: arg.message,
      name: arg.name,
    };
    
    // Capture Axios-specific error properties
    const axiosError = arg as { response?: { status?: number; data?: unknown }; code?: string; config?: { url?: string; method?: string } };
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

function writeLog(level: string, message: string, ...args: unknown[]): void {
  try {
    ensureLogDir();
    const formattedArgs = args.length > 0 
      ? " " + args.map(serializeArg).join(" ")
      : "";
    const line = `[${formatTimestamp()}] [${level}] ${message}${formattedArgs}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {}
}

export const log = {
  info: (message: string, ...args: unknown[]) => writeLog("INFO", message, ...args),
  error: (message: string, ...args: unknown[]) => writeLog("ERROR", message, ...args),
  debug: (message: string, ...args: unknown[]) => writeLog("DEBUG", message, ...args),
  warn: (message: string, ...args: unknown[]) => writeLog("WARN", message, ...args),
};
