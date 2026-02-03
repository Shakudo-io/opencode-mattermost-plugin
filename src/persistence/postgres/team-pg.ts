/**
 * Postgres Team Store
 *
 * Provides CRUD operations for teams and team members stored in PostgreSQL.
 * Supports multi-instance deployments with real-time sync.
 */

import { log } from "../../logger.js";
import {
  type Team,
  type TeamInsert,
  type TeamMember,
  type TeamMemberInsert,
  type TeamMemberRole,
  TeamSchema,
  TeamMemberSchema,
} from "./schema.js";
import { handlePostgrestError, type SupabaseClientManager } from "./supabase-client.js";

const SCHEMA = "opencode_mm_plugin";
const TEAMS_TABLE = "teams";
const TEAM_MEMBERS_TABLE = "team_members";

/**
 * Local team config format (from JSON store)
 */
export interface LocalTeamConfig {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  members: LocalTeamMember[];
  settings: LocalTeamSettings;
}

export interface LocalTeamMember {
  userId: string;
  username: string;
  addedAt: string;
  addedBy: string;
  role: "member" | "admin";
}

export interface LocalTeamSettings {
  allowMembersToCreateSessions: boolean;
  allowMembersToApproveGuests: boolean;
  syncWithMattermostTeam: boolean;
  mattermostTeamId?: string;
}

/**
 * PostgreSQL Team Store Interface
 */
export interface TeamPgStore {
  // Team CRUD
  createTeam(team: TeamInsert): Promise<Team>;
  getTeamById(teamId: string): Promise<Team | null>;
  updateTeam(teamId: string, updates: Partial<TeamInsert>): Promise<Team | null>;
  deleteTeam(teamId: string): Promise<boolean>;
  listTeams(): Promise<Team[]>;

  // Team Member CRUD
  addMember(member: TeamMemberInsert): Promise<TeamMember>;
  getMember(teamId: string, userId: string): Promise<TeamMember | null>;
  updateMember(
    teamId: string,
    userId: string,
    updates: { role?: TeamMemberRole; is_allowed?: boolean; username?: string }
  ): Promise<TeamMember | null>;
  removeMember(teamId: string, userId: string): Promise<boolean>;
  listMembers(teamId: string): Promise<TeamMember[]>;
  isMember(teamId: string, userId: string): Promise<boolean>;
  clearMembers(teamId: string): Promise<number>;

  // Query operations
  getTeamsForUser(userId: string): Promise<Team[]>;
  getMemberCount(teamId: string): Promise<number>;

  // Conversion helpers
  toLocalConfig(team: Team, members: TeamMember[], ownerId: string): LocalTeamConfig;
  fromLocalConfig(config: LocalTeamConfig): { team: TeamInsert; members: TeamMemberInsert[] };
}

/**
 * Create a PostgreSQL team store instance
 */
export function createTeamPgStore(clientManager: SupabaseClientManager): TeamPgStore {
  const { client: supabase } = clientManager;

  // ========== Team Operations ==========

  /**
   * Create a new team
   */
  async function createTeam(team: TeamInsert): Promise<Team> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAMS_TABLE)
      .insert({
        team_id: team.team_id,
        team_name: team.team_name ?? null,
        opencode_project_path: team.opencode_project_path ?? null,
        default_model: team.default_model ?? null,
        settings: team.settings ?? {},
      })
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "create team");
    }

    const result = TeamSchema.parse(data);
    log.info(`[team-pg] Created team: ${result.team_name || result.team_id}`);
    return result;
  }

  /**
   * Get team by ID
   */
  async function getTeamById(teamId: string): Promise<Team | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAMS_TABLE)
      .select("*")
      .eq("team_id", teamId)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get team by id");
    }

    return data ? TeamSchema.parse(data) : null;
  }

  /**
   * Update a team
   */
  async function updateTeam(
    teamId: string,
    updates: Partial<TeamInsert>
  ): Promise<Team | null> {
    const updateData: Record<string, unknown> = { ...updates };
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAMS_TABLE)
      .update(updateData)
      .eq("team_id", teamId)
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "update team");
    }

    if (data) {
      log.debug(`[team-pg] Updated team id=${teamId}`);
      return TeamSchema.parse(data);
    }

    return null;
  }

  /**
   * Delete a team
   */
  async function deleteTeam(teamId: string): Promise<boolean> {
    // First delete all members
    await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .delete()
      .eq("team_id", teamId);

    // Then delete the team
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(TEAMS_TABLE)
      .delete({ count: "exact" })
      .eq("team_id", teamId);

    if (error) {
      handlePostgrestError(error, "delete team");
    }

    if (count && count > 0) {
      log.info(`[team-pg] Deleted team id=${teamId}`);
      return true;
    }

    return false;
  }

  /**
   * List all teams
   */
  async function listTeams(): Promise<Team[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAMS_TABLE)
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list teams");
    }

    return (data || []).map((row) => TeamSchema.parse(row));
  }

  // ========== Team Member Operations ==========

  /**
   * Add a member to a team
   */
  async function addMember(member: TeamMemberInsert): Promise<TeamMember> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .insert({
        team_id: member.team_id,
        mattermost_user_id: member.mattermost_user_id,
        username: member.username ?? null,
        role: member.role ?? "member",
        is_allowed: member.is_allowed ?? true,
      })
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "add team member");
    }

    const result = TeamMemberSchema.parse(data);
    log.info(
      `[team-pg] Added member @${result.username || result.mattermost_user_id} to team ${member.team_id}`
    );
    return result;
  }

  /**
   * Get a specific member
   */
  async function getMember(teamId: string, userId: string): Promise<TeamMember | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .select("*")
      .eq("team_id", teamId)
      .eq("mattermost_user_id", userId)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get team member");
    }

    return data ? TeamMemberSchema.parse(data) : null;
  }

  /**
   * Update a member
   */
  async function updateMember(
    teamId: string,
    userId: string,
    updates: { role?: TeamMemberRole; is_allowed?: boolean; username?: string }
  ): Promise<TeamMember | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .update(updates)
      .eq("team_id", teamId)
      .eq("mattermost_user_id", userId)
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "update team member");
    }

    if (data) {
      log.debug(`[team-pg] Updated member ${userId} in team ${teamId}`);
      return TeamMemberSchema.parse(data);
    }

    return null;
  }

  /**
   * Remove a member from a team
   */
  async function removeMember(teamId: string, userId: string): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .delete({ count: "exact" })
      .eq("team_id", teamId)
      .eq("mattermost_user_id", userId);

    if (error) {
      handlePostgrestError(error, "remove team member");
    }

    if (count && count > 0) {
      log.info(`[team-pg] Removed member ${userId} from team ${teamId}`);
      return true;
    }

    return false;
  }

  /**
   * List all members of a team
   */
  async function listMembers(teamId: string): Promise<TeamMember[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .select("*")
      .eq("team_id", teamId)
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list team members");
    }

    return (data || []).map((row) => TeamMemberSchema.parse(row));
  }

  /**
   * Check if a user is a member of a team
   */
  async function isMember(teamId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .select("id")
      .eq("team_id", teamId)
      .eq("mattermost_user_id", userId)
      .eq("is_allowed", true)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "check team membership");
    }

    return data !== null;
  }

  /**
   * Clear all members from a team
   */
  async function clearMembers(teamId: string): Promise<number> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .delete({ count: "exact" })
      .eq("team_id", teamId);

    if (error) {
      handlePostgrestError(error, "clear team members");
    }

    const deletedCount = count || 0;
    if (deletedCount > 0) {
      log.info(`[team-pg] Cleared ${deletedCount} members from team ${teamId}`);
    }

    return deletedCount;
  }

  // ========== Query Operations ==========

  /**
   * Get all teams a user is a member of
   */
  async function getTeamsForUser(userId: string): Promise<Team[]> {
    // First get all team IDs where user is a member
    const { data: memberRows, error: memberError } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .select("team_id")
      .eq("mattermost_user_id", userId)
      .eq("is_allowed", true);

    if (memberError) {
      handlePostgrestError(memberError, "get teams for user");
    }

    if (!memberRows || memberRows.length === 0) {
      return [];
    }

    const teamIds = memberRows.map((r) => r.team_id);

    // Then fetch the teams
    const { data: teamRows, error: teamError } = await supabase
      .schema(SCHEMA)
      .from(TEAMS_TABLE)
      .select("*")
      .in("team_id", teamIds);

    if (teamError) {
      handlePostgrestError(teamError, "get teams by ids");
    }

    return (teamRows || []).map((row) => TeamSchema.parse(row));
  }

  /**
   * Get member count for a team
   */
  async function getMemberCount(teamId: string): Promise<number> {
    const { count, error } = await supabase
      .schema(SCHEMA)
      .from(TEAM_MEMBERS_TABLE)
      .select("*", { count: "exact", head: true })
      .eq("team_id", teamId)
      .eq("is_allowed", true);

    if (error) {
      handlePostgrestError(error, "get member count");
    }

    return count || 0;
  }

  // ========== Conversion Helpers ==========

  /**
   * Convert DB team + members to local config format
   */
  function toLocalConfig(
    team: Team,
    members: TeamMember[],
    ownerId: string
  ): LocalTeamConfig {
    // Extract settings from the JSONB field
    const dbSettings = (team.settings || {}) as Record<string, unknown>;

    const settings: LocalTeamSettings = {
      allowMembersToCreateSessions: Boolean(dbSettings.allowMembersToCreateSessions ?? true),
      allowMembersToApproveGuests: Boolean(dbSettings.allowMembersToApproveGuests ?? false),
      syncWithMattermostTeam: Boolean(dbSettings.syncWithMattermostTeam ?? false),
      mattermostTeamId: dbSettings.mattermostTeamId as string | undefined,
    };

    return {
      id: team.team_id,
      name: team.team_name || "My Team",
      createdAt: team.created_at.toISOString(),
      updatedAt: team.updated_at.toISOString(),
      ownerId: (dbSettings.ownerId as string) || ownerId,
      members: members.map((m) => ({
        userId: m.mattermost_user_id,
        username: m.username || "",
        addedAt: m.created_at.toISOString(),
        addedBy: (m as Record<string, unknown>).added_by as string || ownerId,
        role: m.role === "admin" ? "admin" : "member",
      })),
      settings,
    };
  }

  /**
   * Convert local config to DB insert formats
   */
  function fromLocalConfig(
    config: LocalTeamConfig
  ): { team: TeamInsert; members: TeamMemberInsert[] } {
    const team: TeamInsert = {
      team_id: config.id,
      team_name: config.name,
      opencode_project_path: null,
      default_model: null,
      settings: {
        ownerId: config.ownerId,
        allowMembersToCreateSessions: config.settings.allowMembersToCreateSessions,
        allowMembersToApproveGuests: config.settings.allowMembersToApproveGuests,
        syncWithMattermostTeam: config.settings.syncWithMattermostTeam,
        mattermostTeamId: config.settings.mattermostTeamId,
      },
    };

    const members: TeamMemberInsert[] = config.members.map((m) => ({
      team_id: config.id,
      mattermost_user_id: m.userId,
      username: m.username,
      role: m.role === "admin" ? "admin" : "member",
      is_allowed: true,
    }));

    return { team, members };
  }

  return {
    // Team operations
    createTeam,
    getTeamById,
    updateTeam,
    deleteTeam,
    listTeams,

    // Member operations
    addMember,
    getMember,
    updateMember,
    removeMember,
    listMembers,
    isMember,
    clearMembers,

    // Query operations
    getTeamsForUser,
    getMemberCount,

    // Conversion helpers
    toLocalConfig,
    fromLocalConfig,
  };
}
