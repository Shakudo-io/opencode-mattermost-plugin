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

function writeLog(level: string, message: string, ...args: unknown[]): void {
  try {
    ensureLogDir();
    const formattedArgs = args.length > 0 
      ? " " + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
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
