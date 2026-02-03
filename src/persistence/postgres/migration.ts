/**
 * Postgres Migration Module
 *
 * Handles migration of data from JSON files to PostgreSQL and vice versa.
 * Supports:
 * - Thread mappings (mattermost-threads.json)
 * - Schedules (mattermost-schedules.json)
 * - Team configuration (mattermost-team.json)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { log } from "../../logger.js";
import type { SupabaseClientManager } from "./supabase-client.js";
import { createThreadMappingPgStore, type ThreadMappingPgStore } from "./thread-mapping-pg.js";
import { createSchedulePgStore, type SchedulePgStore } from "./schedule-pg.js";
import { createTeamPgStore, type TeamPgStore } from "./team-pg.js";
import type { ThreadSessionMapping } from "../../models/index.js";
import { ThreadMappingFileSchema } from "../../models/thread-mapping.js";
import { ScheduleFileSchema, type ScheduleConfig } from "../../scheduler/schedule-store.js";
import type { TeamConfig, TeamConfigFile } from "../team-store.js";

// JSON file paths
const PRIMARY_DIR = join(homedir(), ".config", "opencode");
const FALLBACK_DIR = join(homedir(), ".opencode");

const THREAD_MAPPINGS_FILE = "mattermost-threads.json";
const SCHEDULES_FILE = "mattermost-schedules.json";
const TEAM_FILE = "mattermost-team.json";

/**
 * Progress callback for migration operations
 */
export type MigrationProgressCallback = (message: string) => void;

/**
 * Migration result for a single data type
 */
export interface MigrationResult {
  dataType: "thread_mappings" | "schedules" | "team";
  success: boolean;
  migrated: number;
  skipped: number;
  errors: number;
  message: string;
}

/**
 * Full migration summary
 */
export interface MigrationSummary {
  results: MigrationResult[];
  totalMigrated: number;
  totalSkipped: number;
  totalErrors: number;
  success: boolean;
  message: string;
}

/**
 * Export result for a single data type
 */
export interface ExportResult {
  dataType: "thread_mappings" | "schedules" | "team";
  success: boolean;
  exported: number;
  filePath: string;
  message: string;
}

/**
 * Full export summary
 */
export interface ExportSummary {
  results: ExportResult[];
  totalExported: number;
  success: boolean;
  message: string;
}

/**
 * Resolve the directory where JSON files are stored
 */
function resolveConfigDir(): string {
  if (existsSync(PRIMARY_DIR)) return PRIMARY_DIR;
  if (existsSync(FALLBACK_DIR)) return FALLBACK_DIR;
  return PRIMARY_DIR;
}

/**
 * PostgreSQL Migration Manager
 */
export class MigrationManager {
  private clientManager: SupabaseClientManager;
  private threadMappingPgStore: ThreadMappingPgStore;
  private schedulePgStore: SchedulePgStore;
  private teamPgStore: TeamPgStore;
  private instanceId: string;

  constructor(clientManager: SupabaseClientManager, instanceId: string = "local") {
    this.clientManager = clientManager;
    this.instanceId = instanceId;
    this.threadMappingPgStore = createThreadMappingPgStore(clientManager);
    this.schedulePgStore = createSchedulePgStore(clientManager);
    this.teamPgStore = createTeamPgStore(clientManager);
  }

  // ========== Thread Mappings Migration ==========

  /**
   * Migrate thread mappings from JSON to Postgres
   */
  async migrateThreadMappings(onProgress?: MigrationProgressCallback): Promise<MigrationResult> {
    const configDir = resolveConfigDir();
    const filePath = join(configDir, THREAD_MAPPINGS_FILE);

    onProgress?.(`Reading thread mappings from ${filePath}...`);

    if (!existsSync(filePath)) {
      return {
        dataType: "thread_mappings",
        success: true,
        migrated: 0,
        skipped: 0,
        errors: 0,
        message: "No thread mappings file found - nothing to migrate",
      };
    }

    let mappings: ThreadSessionMapping[] = [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const validated = ThreadMappingFileSchema.safeParse(parsed);

      if (validated.success) {
        mappings = validated.data.mappings;
      } else {
        // Try to extract valid mappings from malformed data
        if (Array.isArray(parsed?.mappings)) {
          for (const m of parsed.mappings) {
            if (m?.sessionId && m?.threadRootPostId) {
              mappings.push(m as ThreadSessionMapping);
            }
          }
        }
      }
    } catch (e) {
      return {
        dataType: "thread_mappings",
        success: false,
        migrated: 0,
        skipped: 0,
        errors: 1,
        message: `Failed to read thread mappings file: ${e}`,
      };
    }

    if (mappings.length === 0) {
      return {
        dataType: "thread_mappings",
        success: true,
        migrated: 0,
        skipped: 0,
        errors: 0,
        message: "Thread mappings file is empty - nothing to migrate",
      };
    }

    onProgress?.(`Found ${mappings.length} thread mappings to migrate`);

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const mapping of mappings) {
      try {
        // Check if already exists in Postgres
        const existing = await this.threadMappingPgStore.getBySessionId(mapping.sessionId);
        if (existing) {
          skipped++;
          onProgress?.(`Skipped: ${mapping.sessionId.substring(0, 8)} (already exists)`);
          continue;
        }

        // Create in Postgres
        await this.threadMappingPgStore.create(mapping);
        migrated++;
        onProgress?.(`Migrated: ${mapping.sessionId.substring(0, 8)} -> ${mapping.projectName || "unknown"}`);
      } catch (e) {
        errors++;
        log.error(`[Migration] Failed to migrate thread mapping ${mapping.sessionId}:`, e);
        onProgress?.(`Error: ${mapping.sessionId.substring(0, 8)} - ${e}`);
      }
    }

    return {
      dataType: "thread_mappings",
      success: errors === 0,
      migrated,
      skipped,
      errors,
      message: `Thread mappings: ${migrated} migrated, ${skipped} skipped, ${errors} errors`,
    };
  }

  // ========== Schedules Migration ==========

  /**
   * Migrate schedules from JSON to Postgres
   */
  async migrateSchedules(onProgress?: MigrationProgressCallback): Promise<MigrationResult> {
    const configDir = resolveConfigDir();
    const filePath = join(configDir, SCHEDULES_FILE);

    onProgress?.(`Reading schedules from ${filePath}...`);

    if (!existsSync(filePath)) {
      return {
        dataType: "schedules",
        success: true,
        migrated: 0,
        skipped: 0,
        errors: 0,
        message: "No schedules file found - nothing to migrate",
      };
    }

    let schedules: ScheduleConfig[] = [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const validated = ScheduleFileSchema.safeParse(parsed);

      if (validated.success) {
        schedules = validated.data.schedules;
      } else {
        // Try to extract valid schedules from malformed data
        if (Array.isArray(parsed?.schedules)) {
          for (const s of parsed.schedules) {
            if (s?.id && s?.name && s?.cron && s?.prompt) {
              schedules.push(s as ScheduleConfig);
            }
          }
        }
      }
    } catch (e) {
      return {
        dataType: "schedules",
        success: false,
        migrated: 0,
        skipped: 0,
        errors: 1,
        message: `Failed to read schedules file: ${e}`,
      };
    }

    if (schedules.length === 0) {
      return {
        dataType: "schedules",
        success: true,
        migrated: 0,
        skipped: 0,
        errors: 0,
        message: "Schedules file is empty - nothing to migrate",
      };
    }

    onProgress?.(`Found ${schedules.length} schedules to migrate`);

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const schedule of schedules) {
      try {
        // Check if already exists by name
        const existing = await this.schedulePgStore.getByName(schedule.name);
        if (existing) {
          skipped++;
          onProgress?.(`Skipped: "${schedule.name}" (already exists)`);
          continue;
        }

        // Convert to Postgres format and create
        const pgData = this.schedulePgStore.fromLocalConfig(schedule, this.instanceId);
        await this.schedulePgStore.create(pgData);
        migrated++;
        onProgress?.(`Migrated: "${schedule.name}" (${schedule.cron})`);
      } catch (e) {
        errors++;
        log.error(`[Migration] Failed to migrate schedule "${schedule.name}":`, e);
        onProgress?.(`Error: "${schedule.name}" - ${e}`);
      }
    }

    return {
      dataType: "schedules",
      success: errors === 0,
      migrated,
      skipped,
      errors,
      message: `Schedules: ${migrated} migrated, ${skipped} skipped, ${errors} errors`,
    };
  }

  // ========== Team Configuration Migration ==========

  /**
   * Migrate team configuration from JSON to Postgres
   */
  async migrateTeamConfig(onProgress?: MigrationProgressCallback): Promise<MigrationResult> {
    const configDir = resolveConfigDir();
    const filePath = join(configDir, TEAM_FILE);

    onProgress?.(`Reading team config from ${filePath}...`);

    if (!existsSync(filePath)) {
      return {
        dataType: "team",
        success: true,
        migrated: 0,
        skipped: 0,
        errors: 0,
        message: "No team config file found - nothing to migrate",
      };
    }

    let teamConfig: TeamConfig | null = null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as TeamConfigFile;

      if (parsed.version === 1 && parsed.team) {
        teamConfig = parsed.team;
      }
    } catch (e) {
      return {
        dataType: "team",
        success: false,
        migrated: 0,
        skipped: 0,
        errors: 1,
        message: `Failed to read team config file: ${e}`,
      };
    }

    if (!teamConfig) {
      return {
        dataType: "team",
        success: true,
        migrated: 0,
        skipped: 0,
        errors: 0,
        message: "Team config file is empty or invalid - nothing to migrate",
      };
    }

    onProgress?.(`Found team "${teamConfig.name}" with ${teamConfig.members.length} members`);

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    try {
      // Check if team already exists
      const existingTeam = await this.teamPgStore.getTeamById(teamConfig.id);
      if (existingTeam) {
        onProgress?.(`Team "${teamConfig.name}" already exists in Postgres`);

        // Merge members that don't exist
        const existingMembers = await this.teamPgStore.listMembers(teamConfig.id);
        const existingUserIds = new Set(existingMembers.map((m) => m.mattermost_user_id));

        for (const member of teamConfig.members) {
          if (!existingUserIds.has(member.userId)) {
            try {
              await this.teamPgStore.addMember({
                team_id: teamConfig.id,
                mattermost_user_id: member.userId,
                username: member.username,
                role: member.role === "admin" ? "admin" : "member",
                is_allowed: true,
              });
              migrated++;
              onProgress?.(`Added member: @${member.username}`);
            } catch (e) {
              errors++;
              onProgress?.(`Failed to add member @${member.username}: ${e}`);
            }
          } else {
            skipped++;
          }
        }

        return {
          dataType: "team",
          success: errors === 0,
          migrated,
          skipped,
          errors,
          message: `Team: ${migrated} members added, ${skipped} already existed, ${errors} errors`,
        };
      }

      // Create new team
      const { team: teamInsert, members: memberInserts } = this.teamPgStore.fromLocalConfig(teamConfig);
      await this.teamPgStore.createTeam(teamInsert);
      migrated++; // Count the team
      onProgress?.(`Created team: "${teamConfig.name}"`);

      // Add members
      for (const memberInsert of memberInserts) {
        try {
          await this.teamPgStore.addMember(memberInsert);
          migrated++;
          onProgress?.(`Added member: @${memberInsert.username}`);
        } catch (e) {
          errors++;
          log.error(`[Migration] Failed to add team member:`, e);
          onProgress?.(`Failed to add member @${memberInsert.username}: ${e}`);
        }
      }

      return {
        dataType: "team",
        success: errors === 0,
        migrated,
        skipped,
        errors,
        message: `Team: "${teamConfig.name}" with ${migrated - 1} members migrated, ${errors} errors`,
      };
    } catch (e) {
      return {
        dataType: "team",
        success: false,
        migrated,
        skipped,
        errors: 1,
        message: `Failed to migrate team config: ${e}`,
      };
    }
  }

  // ========== Full Migration ==========

  /**
   * Run full migration of all data types
   */
  async runFullMigration(onProgress?: MigrationProgressCallback): Promise<MigrationSummary> {
    const results: MigrationResult[] = [];

    onProgress?.("Starting full migration from JSON to Postgres...");
    onProgress?.("");

    // Migrate thread mappings
    onProgress?.("=== Thread Mappings ===");
    const threadResult = await this.migrateThreadMappings(onProgress);
    results.push(threadResult);
    onProgress?.("");

    // Migrate schedules
    onProgress?.("=== Schedules ===");
    const scheduleResult = await this.migrateSchedules(onProgress);
    results.push(scheduleResult);
    onProgress?.("");

    // Migrate team config
    onProgress?.("=== Team Configuration ===");
    const teamResult = await this.migrateTeamConfig(onProgress);
    results.push(teamResult);
    onProgress?.("");

    // Calculate totals
    const totalMigrated = results.reduce((sum, r) => sum + r.migrated, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
    const allSuccess = results.every((r) => r.success);

    return {
      results,
      totalMigrated,
      totalSkipped,
      totalErrors,
      success: allSuccess,
      message: allSuccess
        ? `Migration complete: ${totalMigrated} items migrated, ${totalSkipped} skipped`
        : `Migration completed with errors: ${totalMigrated} migrated, ${totalSkipped} skipped, ${totalErrors} errors`,
    };
  }

  // ========== Export Functions ==========

  /**
   * Export thread mappings from Postgres to JSON
   */
  async exportThreadMappings(onProgress?: MigrationProgressCallback): Promise<ExportResult> {
    const configDir = resolveConfigDir();
    const filePath = join(configDir, `${THREAD_MAPPINGS_FILE}.backup.${Date.now()}`);

    onProgress?.("Exporting thread mappings from Postgres...");

    try {
      const mappings = await this.threadMappingPgStore.listAll();

      if (mappings.length === 0) {
        return {
          dataType: "thread_mappings",
          success: true,
          exported: 0,
          filePath: "",
          message: "No thread mappings in Postgres to export",
        };
      }

      const data = {
        version: 1 as const,
        mappings,
        lastModified: new Date().toISOString(),
      };

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2));

      onProgress?.(`Exported ${mappings.length} thread mappings to ${filePath}`);

      return {
        dataType: "thread_mappings",
        success: true,
        exported: mappings.length,
        filePath,
        message: `Exported ${mappings.length} thread mappings to ${filePath}`,
      };
    } catch (e) {
      return {
        dataType: "thread_mappings",
        success: false,
        exported: 0,
        filePath: "",
        message: `Failed to export thread mappings: ${e}`,
      };
    }
  }

  /**
   * Export schedules from Postgres to JSON
   */
  async exportSchedules(onProgress?: MigrationProgressCallback): Promise<ExportResult> {
    const configDir = resolveConfigDir();
    const filePath = join(configDir, `${SCHEDULES_FILE}.backup.${Date.now()}`);

    onProgress?.("Exporting schedules from Postgres...");

    try {
      const pgSchedules = await this.schedulePgStore.listAll();

      if (pgSchedules.length === 0) {
        return {
          dataType: "schedules",
          success: true,
          exported: 0,
          filePath: "",
          message: "No schedules in Postgres to export",
        };
      }

      // Convert to local format
      const schedules: ScheduleConfig[] = pgSchedules.map((pg) =>
        this.schedulePgStore.toLocalConfig(pg, {})
      );

      const data = {
        version: 1 as const,
        schedules,
        lastModified: new Date().toISOString(),
      };

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2));

      onProgress?.(`Exported ${schedules.length} schedules to ${filePath}`);

      return {
        dataType: "schedules",
        success: true,
        exported: schedules.length,
        filePath,
        message: `Exported ${schedules.length} schedules to ${filePath}`,
      };
    } catch (e) {
      return {
        dataType: "schedules",
        success: false,
        exported: 0,
        filePath: "",
        message: `Failed to export schedules: ${e}`,
      };
    }
  }

  /**
   * Export team config from Postgres to JSON
   */
  async exportTeamConfig(onProgress?: MigrationProgressCallback): Promise<ExportResult> {
    const configDir = resolveConfigDir();
    const filePath = join(configDir, `${TEAM_FILE}.backup.${Date.now()}`);

    onProgress?.("Exporting team config from Postgres...");

    try {
      const teams = await this.teamPgStore.listTeams();

      if (teams.length === 0) {
        return {
          dataType: "team",
          success: true,
          exported: 0,
          filePath: "",
          message: "No team in Postgres to export",
        };
      }

      // For now, export the first team (single-team support)
      const team = teams[0];
      const members = await this.teamPgStore.listMembers(team.team_id);
      const settings = (team.settings || {}) as Record<string, unknown>;
      const ownerId = (settings.ownerId as string) || this.instanceId;

      const teamConfig = this.teamPgStore.toLocalConfig(team, members, ownerId);

      const data: TeamConfigFile = {
        version: 1,
        team: teamConfig,
      };

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2));

      onProgress?.(`Exported team "${teamConfig.name}" with ${members.length} members to ${filePath}`);

      return {
        dataType: "team",
        success: true,
        exported: 1 + members.length, // team + members
        filePath,
        message: `Exported team "${teamConfig.name}" with ${members.length} members to ${filePath}`,
      };
    } catch (e) {
      return {
        dataType: "team",
        success: false,
        exported: 0,
        filePath: "",
        message: `Failed to export team config: ${e}`,
      };
    }
  }

  /**
   * Export all data from Postgres to JSON backup files
   */
  async exportAll(onProgress?: MigrationProgressCallback): Promise<ExportSummary> {
    const results: ExportResult[] = [];

    onProgress?.("Starting full export from Postgres to JSON...");
    onProgress?.("");

    // Export thread mappings
    onProgress?.("=== Thread Mappings ===");
    const threadResult = await this.exportThreadMappings(onProgress);
    results.push(threadResult);
    onProgress?.("");

    // Export schedules
    onProgress?.("=== Schedules ===");
    const scheduleResult = await this.exportSchedules(onProgress);
    results.push(scheduleResult);
    onProgress?.("");

    // Export team config
    onProgress?.("=== Team Configuration ===");
    const teamResult = await this.exportTeamConfig(onProgress);
    results.push(teamResult);
    onProgress?.("");

    const totalExported = results.reduce((sum, r) => sum + r.exported, 0);
    const allSuccess = results.every((r) => r.success);

    return {
      results,
      totalExported,
      success: allSuccess,
      message: allSuccess
        ? `Export complete: ${totalExported} items exported`
        : `Export completed with errors`,
    };
  }
}

/**
 * Create a migration manager instance
 */
export function createMigrationManager(
  clientManager: SupabaseClientManager,
  instanceId: string = "local"
): MigrationManager {
  return new MigrationManager(clientManager, instanceId);
}
