/**
 * Monitor Service for Mattermost Alerts
 * 
 * Enables ephemeral monitoring of OpenCode sessions. When a monitored session
 * triggers an event (permission request, idle, question), sends a one-time
 * DM alert to the specified Mattermost user.
 */
import { MattermostClient } from "./clients/mattermost-client.js";
import { loadConfig, type MattermostConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * Information about a monitored session
 */
export interface MonitoredSession {
  /** Full OpenCode session ID */
  sessionId: string;
  /** Short session ID (first 6 chars) */
  shortId: string;
  /** Mattermost user ID to notify */
  mattermostUserId: string;
  /** Mattermost username (for logging) */
  mattermostUsername: string;
  /** Project name */
  projectName: string;
  /** Working directory */
  directory: string;
  /** When monitoring was registered */
  registeredAt: Date;
}

/**
 * Alert types that trigger notifications
 */
export type AlertType = "permission.asked" | "session.idle" | "question";

/**
 * Alert context passed to formatAlertMessage
 */
export interface AlertContext {
  type: AlertType;
  session: MonitoredSession;
  /** Additional details about what's waiting (e.g., permission description) */
  details?: string;
}

/**
 * In-memory registry of monitored sessions.
 * Key: sessionId (full), Value: MonitoredSession
 */
class MonitorServiceImpl {
  private monitoredSessions: Map<string, MonitoredSession> = new Map();

  /**
   * Register a session for monitoring
   */
  register(session: MonitoredSession): void {
    this.monitoredSessions.set(session.sessionId, session);
    log.info(`[Monitor] Registered session ${session.shortId} (${session.projectName}) for user @${session.mattermostUsername}`);
  }

  /**
   * Unregister a session from monitoring
   */
  unregister(sessionId: string): boolean {
    const session = this.monitoredSessions.get(sessionId);
    if (session) {
      this.monitoredSessions.delete(sessionId);
      log.info(`[Monitor] Unregistered session ${session.shortId}`);
      return true;
    }
    return false;
  }

  /**
   * Check if a session is being monitored
   */
  isMonitored(sessionId: string): boolean {
    return this.monitoredSessions.has(sessionId);
  }

  /**
   * Get a monitored session by ID
   */
  get(sessionId: string): MonitoredSession | undefined {
    return this.monitoredSessions.get(sessionId);
  }

  /**
   * Get all monitored sessions
   */
  getAll(): MonitoredSession[] {
    return Array.from(this.monitoredSessions.values());
  }

  /**
   * Clear all monitored sessions
   */
  clear(): void {
    this.monitoredSessions.clear();
    log.info("[Monitor] Cleared all monitored sessions");
  }

  /**
   * Get count of monitored sessions
   */
  count(): number {
    return this.monitoredSessions.size;
  }
}

export const MonitorService = new MonitorServiceImpl();

/**
 * Format an alert message for Mattermost
 */
export function formatAlertMessage(context: AlertContext): string {
  const { type, session, details } = context;

  const header = `:bell: **OpenCode Session Alert**`;
  const projectLine = `**Project:** ${session.projectName}`;
  const sessionLine = `**Session:** \`${session.shortId}\``;
  const directoryLine = `**Directory:** \`${session.directory}\``;

  let alertTypeText: string;
  let icon: string;

  switch (type) {
    case "permission.asked":
      icon = ":lock:";
      alertTypeText = "Permission requested";
      break;
    case "session.idle":
      icon = ":hourglass:";
      alertTypeText = "Session is idle (waiting for input)";
      break;
    case "question":
      icon = ":question:";
      alertTypeText = "Question awaiting answer";
      break;
    default:
      icon = ":bell:";
      alertTypeText = "Session needs attention";
  }

  const alertLine = `${icon} **Alert:** ${alertTypeText}`;
  const detailsLine = details ? `**Details:** ${details}` : "";
  const actionLine = `\n_Use \`!use ${session.shortId}\` in DM to connect to this session._`;

  const parts = [header, "", projectLine, sessionLine, directoryLine, "", alertLine];
  if (detailsLine) parts.push(detailsLine);
  parts.push(actionLine);

  return parts.join("\n");
}

/**
 * Send an ephemeral alert to a Mattermost user.
 * Creates a new MattermostClient, sends the DM, then discards the client.
 * 
 * @param mattermostUserId - The Mattermost user ID to send the alert to
 * @param message - The formatted message to send
 * @returns true if sent successfully, false otherwise
 */
export async function sendEphemeralAlert(
  mattermostUserId: string,
  message: string
): Promise<boolean> {
  const config = loadConfig();

  if (!config.mattermost.token) {
    log.error("[Monitor] Cannot send alert: MATTERMOST_TOKEN not configured");
    return false;
  }

  if (config.mattermost.baseUrl.includes("your-mattermost-instance.example.com")) {
    log.error("[Monitor] Cannot send alert: MATTERMOST_URL not configured");
    return false;
  }

  let client: MattermostClient | null = null;

  try {
    client = new MattermostClient(config.mattermost);
    const dmChannel = await client.createDirectChannel(mattermostUserId);
    await client.createPost(dmChannel.id, message);

    log.info(`[Monitor] Sent ephemeral alert to user ${mattermostUserId}`);
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`[Monitor] Failed to send ephemeral alert: ${errorMsg}`);
    return false;
  }
}

/**
 * Handle a monitor alert event.
 * Checks if the session is monitored, formats the message, sends the alert,
 * and unregisters the session (one-shot behavior).
 * 
 * @param sessionId - The OpenCode session ID that triggered the event
 * @param alertType - The type of alert
 * @param details - Optional details about the alert
 * @param connectedSessionId - If provided, skip alerting if this matches sessionId
 *                             (already connected via main MM flow)
 * @returns true if alert was sent, false otherwise
 */
export async function handleMonitorAlert(
  sessionId: string,
  alertType: AlertType,
  details?: string,
  connectedSessionId?: string
): Promise<boolean> {
  if (connectedSessionId && sessionId === connectedSessionId) {
    log.debug(`[Monitor] Skipping alert for connected session ${sessionId.slice(0, 6)}`);
    return false;
  }

  const monitoredSession = MonitorService.get(sessionId);
  if (!monitoredSession) {
    return false;
  }

  log.info(`[Monitor] Handling ${alertType} alert for session ${monitoredSession.shortId}`);

  const message = formatAlertMessage({
    type: alertType,
    session: monitoredSession,
    details,
  });

  const sent = await sendEphemeralAlert(monitoredSession.mattermostUserId, message);

  if (sent) {
    MonitorService.unregister(sessionId);
  }

  return sent;
}
