import * as cron from "node-cron";
import { log } from "../logger.js";
import { sendEphemeralAlert } from "../monitor-service.js";
import { ScheduleStore, type ScheduleConfig, generateScheduleId } from "./schedule-store.js";

export interface PromptExecutor {
  (sessionId: string, prompt: string): Promise<string>;
}

export interface SessionChecker {
  (sessionId: string): Promise<boolean>;
}

export interface LeaderChecker {
  (): boolean;
}

export interface LeadershipChangeSubscriber {
  (callback: (isLeader: boolean) => void): () => void;
}

export interface SchedulerServiceConfig {
  promptExecutor?: PromptExecutor;
  sessionChecker?: SessionChecker;
  leaderChecker?: LeaderChecker;
  onLeadershipChange?: LeadershipChangeSubscriber;
  /**
   * Maximum age (in ms) of overdue tasks to run catch-up for when becoming leader.
   * Tasks older than this are skipped with a warning.
   * Default: 1 hour (3600000 ms)
   */
  catchUpMaxAge?: number;
}

const DEFAULT_CATCH_UP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export class SchedulerService {
  private store: ScheduleStore;
  private jobs: Map<string, cron.ScheduledTask> = new Map();
  private promptExecutor: PromptExecutor | null = null;
  private sessionChecker: SessionChecker | null = null;
  private leaderChecker: LeaderChecker | null = null;
  private leadershipUnsubscribe: (() => void) | null = null;
  private catchUpMaxAge: number;
  private started: boolean = false;
  private runningScheduledSessions: Set<string> = new Set();

  constructor(config: SchedulerServiceConfig = {}) {
    this.store = new ScheduleStore();
    this.promptExecutor = config.promptExecutor || null;
    this.sessionChecker = config.sessionChecker || null;
    this.leaderChecker = config.leaderChecker || null;
    this.catchUpMaxAge = config.catchUpMaxAge ?? DEFAULT_CATCH_UP_MAX_AGE_MS;

    if (config.onLeadershipChange) {
      this.leadershipUnsubscribe = config.onLeadershipChange((isLeader) => {
        this.handleLeadershipChange(isLeader);
      });
    }
  }

  setPromptExecutor(executor: PromptExecutor): void {
    this.promptExecutor = executor;
  }

  setSessionChecker(checker: SessionChecker): void {
    this.sessionChecker = checker;
  }

  setLeaderChecker(checker: LeaderChecker): void {
    this.leaderChecker = checker;
  }

  isRunningScheduledTask(sessionId: string): boolean {
    return this.runningScheduledSessions.has(sessionId);
  }

  private isLeader(): boolean {
    if (!this.leaderChecker) {
      return true;
    }
    return this.leaderChecker();
  }

  private async handleLeadershipChange(isLeader: boolean): Promise<void> {
    if (isLeader) {
      log.info("[SchedulerService] Acquired leadership, checking for overdue tasks");
      await this.runCatchUpTasks();
    } else {
      log.info("[SchedulerService] Lost leadership, scheduled task execution paused");
    }
  }

  private async runCatchUpTasks(): Promise<void> {
    const schedules = this.store.listEnabled();
    const now = Date.now();
    const catchUpThreshold = now - this.catchUpMaxAge;

    for (const schedule of schedules) {
      if (!schedule.lastRunAt) {
        continue;
      }

      const lastRunTime = new Date(schedule.lastRunAt).getTime();
      const timeSinceLastRun = now - lastRunTime;

      const nextExpectedRun = this.calculateNextRunAfter(schedule.cron, schedule.timezone, new Date(lastRunTime));
      if (!nextExpectedRun) {
        continue;
      }

      const nextExpectedTime = nextExpectedRun.getTime();
      if (nextExpectedTime > now) {
        continue;
      }

      if (nextExpectedTime < catchUpThreshold) {
        log.warn(
          `[SchedulerService] Skipping overdue task "${schedule.name}" - last expected run was ${Math.round(
            (now - nextExpectedTime) / 60000
          )} minutes ago (exceeds ${Math.round(this.catchUpMaxAge / 60000)} minute threshold)`
        );
        continue;
      }

      log.info(
        `[SchedulerService] Running catch-up task "${schedule.name}" - was due ${Math.round(
          (now - nextExpectedTime) / 60000
        )} minutes ago`
      );
      await this.runTask(schedule);
    }
  }

  private calculateNextRunAfter(cronExpression: string, timezone: string, after: Date): Date | null {
    try {
      const CronExpressionParser = require("cron-parser").default;
      const interval = CronExpressionParser.parse(cronExpression, {
        currentDate: after,
        tz: timezone,
      });
      return interval.next().toDate();
    } catch {
      return null;
    }
  }

  async rebindAllToSession(currentSessionId: string): Promise<number> {
    const allSchedules = this.store.listAll();
    let rebound = 0;

    for (const schedule of allSchedules) {
      if (schedule.sessionId !== currentSessionId) {
        const oldSessionId = schedule.sessionId;
        schedule.sessionId = currentSessionId;
        await this.store.update(schedule);
        rebound++;
        log.info(
          `[SchedulerService] Re-bound schedule "${schedule.name}" from ${oldSessionId.substring(0, 12)} → ${currentSessionId.substring(0, 12)}`
        );
      }
    }

    if (rebound > 0) {
      log.info(`[SchedulerService] Re-bound ${rebound} schedules to session ${currentSessionId.substring(0, 12)}`);
    } else {
      log.debug(`[SchedulerService] All schedules already bound to current session`);
    }

    return rebound;
  }

  async start(): Promise<void> {
    if (this.started) {
      log.warn("[SchedulerService] Already started");
      return;
    }

    await this.store.load();
    const schedules = this.store.listEnabled();

    for (const schedule of schedules) {
      this.startJob(schedule);
    }

    this.started = true;
    log.info(`[SchedulerService] Started with ${schedules.length} active schedules`);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.leadershipUnsubscribe) {
      this.leadershipUnsubscribe();
      this.leadershipUnsubscribe = null;
    }

    for (const [id, job] of this.jobs) {
      job.stop();
      log.debug(`[SchedulerService] Stopped job: ${id}`);
    }
    this.jobs.clear();

    this.store.shutdown();
    this.started = false;
    log.info("[SchedulerService] Stopped");
  }

  private startJob(schedule: ScheduleConfig): boolean {
    if (this.jobs.has(schedule.id)) {
      log.warn(`[SchedulerService] Job already running: ${schedule.id}`);
      return false;
    }

    if (!cron.validate(schedule.cron)) {
      log.error(`[SchedulerService] Invalid cron expression for ${schedule.name}: ${schedule.cron}`);
      return false;
    }

    const job = cron.schedule(
      schedule.cron,
      async () => {
        await this.runTask(schedule);
      },
      {
        timezone: schedule.timezone,
      }
    );

    this.jobs.set(schedule.id, job);
    log.info(`[SchedulerService] Started job: ${schedule.name} (${schedule.cron} ${schedule.timezone})`);
    return true;
  }

  private stopJob(scheduleId: string): boolean {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
      log.debug(`[SchedulerService] Stopped job: ${scheduleId}`);
      return true;
    }
    return false;
  }

  private async runTask(schedule: ScheduleConfig, skipLeaderCheck = false): Promise<void> {
    if (!skipLeaderCheck && !this.isLeader()) {
      log.debug(`[SchedulerService] Skipping task "${schedule.name}" - not the leader`);
      return;
    }

    log.info(`[SchedulerService] Running scheduled task: ${schedule.name}${this.leaderChecker ? " (leader)" : ""}`);

    if (!this.promptExecutor) {
      log.error(`[SchedulerService] No prompt executor configured`);
      await this.sendErrorDm(
        schedule,
        `Schedule "${schedule.name}" could not run: Plugin not fully initialized.`
      );
      this.store.updateLastRun(schedule.id, false, "No prompt executor configured");
      return;
    }

    if (this.sessionChecker) {
      const sessionExists = await this.sessionChecker(schedule.sessionId);
      if (!sessionExists) {
        log.warn(`[SchedulerService] Session ${schedule.sessionId} not available for schedule ${schedule.name}`);
        await this.sendErrorDm(
          schedule,
          `Schedule "${schedule.name}" could not run: Session \`${schedule.sessionId.slice(0, 8)}\` is no longer available.\n\nYou may need to recreate this schedule in an active session.`
        );
        this.store.updateLastRun(schedule.id, false, "Session not available");
        return;
      }
    }

    this.runningScheduledSessions.add(schedule.sessionId);
    log.debug(`[SchedulerService] Marked session ${schedule.sessionId.slice(0, 8)} as running scheduled task`);
    
    try {
      const prefixedPrompt = `[Scheduled Task: ${schedule.name}]\n${schedule.prompt}\n\n[Important: Format your response for a Mattermost DM. Keep it concise and actionable.]`;
      
      log.debug(`[SchedulerService] Injecting prompt into session ${schedule.sessionId.slice(0, 8)}`);
      const response = await this.promptExecutor(schedule.sessionId, prefixedPrompt);

      if (response) {
        const message = `:bell: **Scheduled: ${schedule.name}**\n\n${response}`;
        await sendEphemeralAlert(schedule.targetUserId, message);
        log.info(`[SchedulerService] Sent scheduled response to @${schedule.targetUsername}`);
        this.store.updateLastRun(schedule.id, true);
      } else {
        log.warn(`[SchedulerService] Empty response from LLM for schedule ${schedule.name}`);
        this.store.updateLastRun(schedule.id, false, "Empty response from LLM");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`[SchedulerService] Task failed for ${schedule.name}:`, error);
      
      await this.sendErrorDm(
        schedule,
        `Schedule "${schedule.name}" failed: ${errorMsg}`
      );
      this.store.updateLastRun(schedule.id, false, errorMsg);
    } finally {
      this.runningScheduledSessions.delete(schedule.sessionId);
      log.debug(`[SchedulerService] Unmarked session ${schedule.sessionId.slice(0, 8)} from running scheduled task`);
    }
  }

  private async sendErrorDm(schedule: ScheduleConfig, message: string): Promise<void> {
    const errorMessage = `:warning: **Scheduled Task Error**\n\n${message}`;
    await sendEphemeralAlert(schedule.targetUserId, errorMessage);
  }

  async addSchedule(params: {
    name: string;
    cron: string;
    timezone?: string;
    prompt: string;
    sessionId: string;
    targetUserId: string;
    targetUsername: string;
    enabled?: boolean;
  }): Promise<ScheduleConfig> {
    if (!cron.validate(params.cron)) {
      throw new Error(`Invalid cron expression: ${params.cron}`);
    }

    const existing = this.store.getByName(params.name);
    if (existing) {
      throw new Error(`Schedule with name "${params.name}" already exists`);
    }

    const schedule: ScheduleConfig = {
      id: generateScheduleId(),
      name: params.name,
      cron: params.cron,
      timezone: params.timezone || "UTC",
      prompt: params.prompt,
      sessionId: params.sessionId,
      targetUserId: params.targetUserId,
      targetUsername: params.targetUsername,
      enabled: params.enabled ?? true,
      createdAt: new Date().toISOString(),
    };

    this.store.add(schedule);

    if (schedule.enabled && this.started) {
      this.startJob(schedule);
    }

    log.info(`[SchedulerService] Added schedule: ${schedule.name} (${schedule.cron})`);
    return schedule;
  }

  async removeSchedule(scheduleId: string): Promise<boolean> {
    this.stopJob(scheduleId);
    const removed = await this.store.remove(scheduleId);
    if (removed) {
      log.info(`[SchedulerService] Removed schedule: ${scheduleId}`);
    }
    return removed;
  }

  async removeScheduleByName(name: string): Promise<boolean> {
    const schedule = this.store.getByName(name);
    if (schedule) {
      return this.removeSchedule(schedule.id);
    }
    return false;
  }

  async enableSchedule(scheduleId: string): Promise<boolean> {
    const schedule = this.store.getById(scheduleId);
    if (!schedule) {
      return false;
    }

    if (schedule.enabled) {
      return true;
    }

    await this.store.setEnabled(scheduleId, true);
    if (this.started) {
      this.startJob(schedule);
    }
    log.info(`[SchedulerService] Enabled schedule: ${schedule.name}`);
    return true;
  }

  async disableSchedule(scheduleId: string): Promise<boolean> {
    const schedule = this.store.getById(scheduleId);
    if (!schedule) {
      return false;
    }

    if (!schedule.enabled) {
      return true;
    }

    this.stopJob(scheduleId);
    await this.store.setEnabled(scheduleId, false);
    log.info(`[SchedulerService] Disabled schedule: ${schedule.name}`);
    return true;
  }

  listSchedules(): ScheduleConfig[] {
    return this.store.listAll();
  }

  getSchedule(scheduleId: string): ScheduleConfig | null {
    return this.store.getById(scheduleId);
  }

  getScheduleByName(name: string): ScheduleConfig | null {
    return this.store.getByName(name);
  }

  getSchedulesForUser(userId: string): ScheduleConfig[] {
    return this.store.getByUserId(userId);
  }

  getSchedulesForSession(sessionId: string): ScheduleConfig[] {
    return this.store.getBySessionId(sessionId);
  }

  isRunning(scheduleId: string): boolean {
    return this.jobs.has(scheduleId);
  }

  async runNow(scheduleId: string): Promise<boolean> {
    const schedule = this.store.getById(scheduleId);
    if (!schedule) {
      return false;
    }

    await this.runTask(schedule);
    return true;
  }

  async runNowByName(name: string): Promise<boolean> {
    const schedule = this.store.getByName(name);
    if (!schedule) {
      return false;
    }

    await this.runTask(schedule);
    return true;
  }

  getStats(): {
    total: number;
    enabled: number;
    running: number;
  } {
    return {
      total: this.store.count(),
      enabled: this.store.listEnabled().length,
      running: this.jobs.size,
    };
  }
}

let schedulerInstance: SchedulerService | null = null;

export function getSchedulerService(): SchedulerService {
  if (!schedulerInstance) {
    schedulerInstance = new SchedulerService();
  }
  return schedulerInstance;
}

export function resetSchedulerService(): void {
  if (schedulerInstance) {
    schedulerInstance.stop();
    schedulerInstance = null;
  }
}
