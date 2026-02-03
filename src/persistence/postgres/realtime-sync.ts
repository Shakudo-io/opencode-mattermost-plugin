import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { SupabaseClientManager } from "./supabase-client.js";
import {
  ThreadMappingSchema,
  ScheduleSchema,
  TeamSchema,
  TeamMemberSchema,
  PendingQuestionSchema,
  PendingApprovalSchema,
  PendingOwnershipSchema,
  type ThreadMapping,
  type Schedule,
  type Team,
  type TeamMember,
  type PendingQuestion,
  type PendingApproval,
  type PendingOwnership,
} from "./schema.js";
import { log } from "../../logger.js";

export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE";

export type ThreadMappingChangeEvent = {
  eventType: RealtimeEventType;
  old: ThreadMapping | null;
  new: ThreadMapping | null;
  timestamp: Date;
};

export type ScheduleChangeEvent = {
  eventType: RealtimeEventType;
  old: Schedule | null;
  new: Schedule | null;
  timestamp: Date;
};

export type TeamChangeEvent = {
  eventType: RealtimeEventType;
  old: Team | null;
  new: Team | null;
  timestamp: Date;
};

export type TeamMemberChangeEvent = {
  eventType: RealtimeEventType;
  old: TeamMember | null;
  new: TeamMember | null;
  timestamp: Date;
};

export type PendingQuestionChangeEvent = {
  eventType: RealtimeEventType;
  old: PendingQuestion | null;
  new: PendingQuestion | null;
  timestamp: Date;
};

export type PendingApprovalChangeEvent = {
  eventType: RealtimeEventType;
  old: PendingApproval | null;
  new: PendingApproval | null;
  timestamp: Date;
};

export type PendingOwnershipChangeEvent = {
  eventType: RealtimeEventType;
  old: PendingOwnership | null;
  new: PendingOwnership | null;
  timestamp: Date;
};

export type RealtimeSyncOptions = {
  clientManager: SupabaseClientManager;
  instanceId: string;
  onThreadMappingChange?: (event: ThreadMappingChangeEvent) => void;
  onScheduleChange?: (event: ScheduleChangeEvent) => void;
  onTeamChange?: (event: TeamChangeEvent) => void;
  onTeamMemberChange?: (event: TeamMemberChangeEvent) => void;
  onPendingQuestionChange?: (event: PendingQuestionChangeEvent) => void;
  onPendingApprovalChange?: (event: PendingApprovalChangeEvent) => void;
  onPendingOwnershipChange?: (event: PendingOwnershipChangeEvent) => void;
  pollingIntervalMs?: number;
};

export type RealtimeSync = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isConnected: () => boolean;
  isPolling: () => boolean;
};

const DEFAULT_POLLING_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

export function createRealtimeSync(options: RealtimeSyncOptions): RealtimeSync {
  const {
    clientManager,
    instanceId,
    onThreadMappingChange,
    onScheduleChange,
    onTeamChange,
    onTeamMemberChange,
    onPendingQuestionChange,
    onPendingApprovalChange,
    onPendingOwnershipChange,
    pollingIntervalMs = DEFAULT_POLLING_INTERVAL_MS,
  } = options;

  let threadMappingChannel: RealtimeChannel | null = null;
  let scheduleChannel: RealtimeChannel | null = null;
  let teamChannel: RealtimeChannel | null = null;
  let teamMemberChannel: RealtimeChannel | null = null;
  let pendingQuestionChannel: RealtimeChannel | null = null;
  let pendingApprovalChannel: RealtimeChannel | null = null;
  let pendingOwnershipChannel: RealtimeChannel | null = null;
  let isConnected = false;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempts = 0;
  let stopped = false;
  let lastKnownUpdatedAt: Date | null = null;
  let lastKnownScheduleUpdatedAt: Date | null = null;
  let lastKnownTeamUpdatedAt: Date | null = null;
  let lastKnownTeamMemberCreatedAt: Date | null = null;
  let lastKnownPendingQuestionCreatedAt: Date | null = null;
  let lastKnownPendingApprovalCreatedAt: Date | null = null;
  let lastKnownPendingOwnershipCreatedAt: Date | null = null;

  async function subscribeToThreadMappings(): Promise<void> {
    if (stopped) return;

    const { client } = clientManager;

    threadMappingChannel = client
      .channel("thread_mappings_changes")
      .on<ThreadMapping>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "thread_mappings",
        },
        (payload: RealtimePostgresChangesPayload<ThreadMapping>) => {
          handleThreadMappingChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to thread_mappings Realtime channel`);
          isConnected = true;
          reconnectAttempts = 0;
          stopPolling();
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Thread mappings channel ${status}, starting fallback polling`);
          isConnected = false;
          startPolling();
          scheduleReconnect();
        }
      });
  }

  function handleThreadMappingChange(payload: RealtimePostgresChangesPayload<ThreadMapping>): void {
    if (!onThreadMappingChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: ThreadMapping | null = null;
      let newRecord: ThreadMapping | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = ThreadMappingSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = ThreadMappingSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: ThreadMappingChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Thread mapping ${eventType}: session=${newRecord?.opencode_session_id || oldRecord?.opencode_session_id}`
      );

      onThreadMappingChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing thread mapping change:", e);
    }
  }

  async function subscribeToSchedules(): Promise<void> {
    if (stopped || !onScheduleChange) return;

    const { client } = clientManager;

    scheduleChannel = client
      .channel("schedules_changes")
      .on<Schedule>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "schedules",
        },
        (payload: RealtimePostgresChangesPayload<Schedule>) => {
          handleScheduleChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to schedules Realtime channel`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Schedules channel ${status}`);
        }
      });
  }

  function handleScheduleChange(payload: RealtimePostgresChangesPayload<Schedule>): void {
    if (!onScheduleChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: Schedule | null = null;
      let newRecord: Schedule | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = ScheduleSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = ScheduleSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: ScheduleChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Schedule ${eventType}: name=${newRecord?.name || oldRecord?.name}, enabled=${newRecord?.enabled}`
      );

      onScheduleChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing schedule change:", e);
    }
  }

  async function subscribeToTeams(): Promise<void> {
    if (stopped || !onTeamChange) return;

    const { client } = clientManager;

    teamChannel = client
      .channel("teams_changes")
      .on<Team>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "teams",
        },
        (payload: RealtimePostgresChangesPayload<Team>) => {
          handleTeamChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to teams Realtime channel`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Teams channel ${status}`);
        }
      });
  }

  function handleTeamChange(payload: RealtimePostgresChangesPayload<Team>): void {
    if (!onTeamChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: Team | null = null;
      let newRecord: Team | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = TeamSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = TeamSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: TeamChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Team ${eventType}: id=${newRecord?.team_id || oldRecord?.team_id}, name=${newRecord?.team_name || oldRecord?.team_name}`
      );

      onTeamChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing team change:", e);
    }
  }

  async function subscribeToTeamMembers(): Promise<void> {
    if (stopped || !onTeamMemberChange) return;

    const { client } = clientManager;

    teamMemberChannel = client
      .channel("team_members_changes")
      .on<TeamMember>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "team_members",
        },
        (payload: RealtimePostgresChangesPayload<TeamMember>) => {
          handleTeamMemberChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to team_members Realtime channel`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Team members channel ${status}`);
        }
      });
  }

  function handleTeamMemberChange(payload: RealtimePostgresChangesPayload<TeamMember>): void {
    if (!onTeamMemberChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: TeamMember | null = null;
      let newRecord: TeamMember | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = TeamMemberSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = TeamMemberSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: TeamMemberChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.info(
        `[realtime-sync] Team member ${eventType}: team=${newRecord?.team_id || oldRecord?.team_id}, user=${newRecord?.mattermost_user_id || oldRecord?.mattermost_user_id}, username=${newRecord?.username || oldRecord?.username}`
      );

      onTeamMemberChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing team member change:", e);
    }
  }

  async function subscribeToPendingQuestions(): Promise<void> {
    if (stopped || !onPendingQuestionChange) return;

    const { client } = clientManager;

    pendingQuestionChannel = client
      .channel("pending_questions_changes")
      .on<PendingQuestion>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "pending_questions",
        },
        (payload: RealtimePostgresChangesPayload<PendingQuestion>) => {
          handlePendingQuestionChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to pending_questions Realtime channel`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Pending questions channel ${status}`);
        }
      });
  }

  function handlePendingQuestionChange(payload: RealtimePostgresChangesPayload<PendingQuestion>): void {
    if (!onPendingQuestionChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: PendingQuestion | null = null;
      let newRecord: PendingQuestion | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = PendingQuestionSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = PendingQuestionSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: PendingQuestionChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Pending question ${eventType}: id=${newRecord?.id || oldRecord?.id}, status=${newRecord?.status || oldRecord?.status}`
      );

      onPendingQuestionChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing pending question change:", e);
    }
  }

  async function subscribeToPendingApprovals(): Promise<void> {
    if (stopped || !onPendingApprovalChange) return;

    const { client } = clientManager;

    pendingApprovalChannel = client
      .channel("pending_approvals_changes")
      .on<PendingApproval>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "pending_approvals",
        },
        (payload: RealtimePostgresChangesPayload<PendingApproval>) => {
          handlePendingApprovalChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to pending_approvals Realtime channel`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Pending approvals channel ${status}`);
        }
      });
  }

  function handlePendingApprovalChange(payload: RealtimePostgresChangesPayload<PendingApproval>): void {
    if (!onPendingApprovalChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: PendingApproval | null = null;
      let newRecord: PendingApproval | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = PendingApprovalSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = PendingApprovalSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: PendingApprovalChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Pending approval ${eventType}: id=${newRecord?.id || oldRecord?.id}, guest=${newRecord?.guest_username || oldRecord?.guest_username}, status=${newRecord?.status || oldRecord?.status}`
      );

      onPendingApprovalChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing pending approval change:", e);
    }
  }

  async function subscribeToPendingOwnerships(): Promise<void> {
    if (stopped || !onPendingOwnershipChange) return;

    const { client } = clientManager;

    pendingOwnershipChannel = client
      .channel("pending_ownerships_changes")
      .on<PendingOwnership>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "pending_ownerships",
        },
        (payload: RealtimePostgresChangesPayload<PendingOwnership>) => {
          handlePendingOwnershipChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to pending_ownerships Realtime channel`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Pending ownerships channel ${status}`);
        }
      });
  }

  function handlePendingOwnershipChange(payload: RealtimePostgresChangesPayload<PendingOwnership>): void {
    if (!onPendingOwnershipChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: PendingOwnership | null = null;
      let newRecord: PendingOwnership | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = PendingOwnershipSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = PendingOwnershipSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: PendingOwnershipChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Pending ownership ${eventType}: id=${newRecord?.id || oldRecord?.id}, claimingUser=${newRecord?.claiming_user_id || oldRecord?.claiming_user_id}, status=${newRecord?.status || oldRecord?.status}`
      );

      onPendingOwnershipChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing pending ownership change:", e);
    }
  }

  function startPolling(): void {
    if (pollingTimer || stopped) return;

    log.info(`[realtime-sync] Starting fallback polling every ${pollingIntervalMs}ms`);

    pollingTimer = setInterval(async () => {
      await pollForChanges();
    }, pollingIntervalMs);
  }

  function stopPolling(): void {
    if (pollingTimer) {
      log.info("[realtime-sync] Stopping fallback polling (Realtime reconnected)");
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  async function pollForChanges(): Promise<void> {
    await pollThreadMappings();
    await pollSchedules();
    await pollTeams();
    await pollTeamMembers();
    await pollPendingQuestions();
    await pollPendingApprovals();
    await pollPendingOwnerships();
  }

  async function pollThreadMappings(): Promise<void> {
    if (!onThreadMappingChange) return;

    try {
      const { client } = clientManager;
      let query = client.from("thread_mappings").select("*").order("updated_at", { ascending: false });

      if (lastKnownUpdatedAt) {
        query = query.gt("updated_at", lastKnownUpdatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Thread mappings polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = ThreadMappingSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: ThreadMappingChangeEvent = {
          eventType: "UPDATE",
          old: null,
          new: record,
          timestamp: new Date(record.updated_at),
        };

        onThreadMappingChange(event);

        if (!lastKnownUpdatedAt || record.updated_at > lastKnownUpdatedAt) {
          lastKnownUpdatedAt = record.updated_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} updated thread mappings`);
    } catch (e) {
      log.error("[realtime-sync] Thread mappings polling exception:", e);
    }
  }

  async function pollSchedules(): Promise<void> {
    if (!onScheduleChange) return;

    try {
      const { client } = clientManager;
      let query = client.from("schedules").select("*").order("updated_at", { ascending: false });

      if (lastKnownScheduleUpdatedAt) {
        query = query.gt("updated_at", lastKnownScheduleUpdatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Schedules polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = ScheduleSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: ScheduleChangeEvent = {
          eventType: "UPDATE",
          old: null,
          new: record,
          timestamp: new Date(record.updated_at),
        };

        onScheduleChange(event);

        if (!lastKnownScheduleUpdatedAt || record.updated_at > lastKnownScheduleUpdatedAt) {
          lastKnownScheduleUpdatedAt = record.updated_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} updated schedules`);
    } catch (e) {
      log.error("[realtime-sync] Schedules polling exception:", e);
    }
  }

  async function pollTeams(): Promise<void> {
    if (!onTeamChange) return;

    try {
      const { client } = clientManager;
      let query = client
        .schema("opencode_mm_plugin")
        .from("teams")
        .select("*")
        .order("updated_at", { ascending: false });

      if (lastKnownTeamUpdatedAt) {
        query = query.gt("updated_at", lastKnownTeamUpdatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Teams polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = TeamSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: TeamChangeEvent = {
          eventType: "UPDATE",
          old: null,
          new: record,
          timestamp: new Date(record.updated_at),
        };

        onTeamChange(event);

        if (!lastKnownTeamUpdatedAt || record.updated_at > lastKnownTeamUpdatedAt) {
          lastKnownTeamUpdatedAt = record.updated_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} updated teams`);
    } catch (e) {
      log.error("[realtime-sync] Teams polling exception:", e);
    }
  }

  async function pollTeamMembers(): Promise<void> {
    if (!onTeamMemberChange) return;

    try {
      const { client } = clientManager;
      // Team members don't have updated_at, only created_at - so we track new members
      let query = client
        .schema("opencode_mm_plugin")
        .from("team_members")
        .select("*")
        .order("created_at", { ascending: false });

      if (lastKnownTeamMemberCreatedAt) {
        query = query.gt("created_at", lastKnownTeamMemberCreatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Team members polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = TeamMemberSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: TeamMemberChangeEvent = {
          eventType: "INSERT", // Polling only catches new members
          old: null,
          new: record,
          timestamp: new Date(record.created_at),
        };

        onTeamMemberChange(event);

        if (!lastKnownTeamMemberCreatedAt || record.created_at > lastKnownTeamMemberCreatedAt) {
          lastKnownTeamMemberCreatedAt = record.created_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} new team members`);
    } catch (e) {
      log.error("[realtime-sync] Team members polling exception:", e);
    }
  }

  async function pollPendingQuestions(): Promise<void> {
    if (!onPendingQuestionChange) return;

    try {
      const { client } = clientManager;
      let query = client
        .schema("opencode_mm_plugin")
        .from("pending_questions")
        .select("*")
        .order("created_at", { ascending: false });

      if (lastKnownPendingQuestionCreatedAt) {
        query = query.gt("created_at", lastKnownPendingQuestionCreatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Pending questions polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = PendingQuestionSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: PendingQuestionChangeEvent = {
          eventType: "INSERT",
          old: null,
          new: record,
          timestamp: new Date(record.created_at),
        };

        onPendingQuestionChange(event);

        if (!lastKnownPendingQuestionCreatedAt || record.created_at > lastKnownPendingQuestionCreatedAt) {
          lastKnownPendingQuestionCreatedAt = record.created_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} new pending questions`);
    } catch (e) {
      log.error("[realtime-sync] Pending questions polling exception:", e);
    }
  }

  async function pollPendingApprovals(): Promise<void> {
    if (!onPendingApprovalChange) return;

    try {
      const { client } = clientManager;
      let query = client
        .schema("opencode_mm_plugin")
        .from("pending_approvals")
        .select("*")
        .order("created_at", { ascending: false });

      if (lastKnownPendingApprovalCreatedAt) {
        query = query.gt("created_at", lastKnownPendingApprovalCreatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Pending approvals polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = PendingApprovalSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: PendingApprovalChangeEvent = {
          eventType: "INSERT",
          old: null,
          new: record,
          timestamp: new Date(record.created_at),
        };

        onPendingApprovalChange(event);

        if (!lastKnownPendingApprovalCreatedAt || record.created_at > lastKnownPendingApprovalCreatedAt) {
          lastKnownPendingApprovalCreatedAt = record.created_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} new pending approvals`);
    } catch (e) {
      log.error("[realtime-sync] Pending approvals polling exception:", e);
    }
  }

  async function pollPendingOwnerships(): Promise<void> {
    if (!onPendingOwnershipChange) return;

    try {
      const { client } = clientManager;
      let query = client
        .schema("opencode_mm_plugin")
        .from("pending_ownerships")
        .select("*")
        .order("created_at", { ascending: false });

      if (lastKnownPendingOwnershipCreatedAt) {
        query = query.gt("created_at", lastKnownPendingOwnershipCreatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Pending ownerships polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = PendingOwnershipSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: PendingOwnershipChangeEvent = {
          eventType: "INSERT",
          old: null,
          new: record,
          timestamp: new Date(record.created_at),
        };

        onPendingOwnershipChange(event);

        if (!lastKnownPendingOwnershipCreatedAt || record.created_at > lastKnownPendingOwnershipCreatedAt) {
          lastKnownPendingOwnershipCreatedAt = record.created_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} new pending ownerships`);
    } catch (e) {
      log.error("[realtime-sync] Pending ownerships polling exception:", e);
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log.error(
          `[realtime-sync] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, staying in polling mode`
        );
      }
      return;
    }

    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);

    log.info(`[realtime-sync] Scheduling reconnect attempt ${reconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      if (stopped || isConnected) return;

      try {
        await unsubscribeFromChannels();
        await subscribeToThreadMappings();
        await subscribeToSchedules();
        await subscribeToTeams();
        await subscribeToTeamMembers();
        await subscribeToPendingQuestions();
        await subscribeToPendingApprovals();
        await subscribeToPendingOwnerships();
      } catch (e) {
        log.error("[realtime-sync] Reconnect failed:", e);
        scheduleReconnect();
      }
    }, delay);
  }

  async function unsubscribeFromChannels(): Promise<void> {
    if (threadMappingChannel) {
      await threadMappingChannel.unsubscribe();
      threadMappingChannel = null;
    }
    if (scheduleChannel) {
      await scheduleChannel.unsubscribe();
      scheduleChannel = null;
    }
    if (teamChannel) {
      await teamChannel.unsubscribe();
      teamChannel = null;
    }
    if (teamMemberChannel) {
      await teamMemberChannel.unsubscribe();
      teamMemberChannel = null;
    }
    if (pendingQuestionChannel) {
      await pendingQuestionChannel.unsubscribe();
      pendingQuestionChannel = null;
    }
    if (pendingApprovalChannel) {
      await pendingApprovalChannel.unsubscribe();
      pendingApprovalChannel = null;
    }
    if (pendingOwnershipChannel) {
      await pendingOwnershipChannel.unsubscribe();
      pendingOwnershipChannel = null;
    }
  }

  return {
    async start() {
      stopped = false;
      log.info(`[realtime-sync] Starting Realtime sync for instance ${instanceId}`);

      try {
        await subscribeToThreadMappings();
        await subscribeToSchedules();
        await subscribeToTeams();
        await subscribeToTeamMembers();
        await subscribeToPendingQuestions();
        await subscribeToPendingApprovals();
        await subscribeToPendingOwnerships();
      } catch (e) {
        log.error("[realtime-sync] Failed to start Realtime subscription, falling back to polling:", e);
        startPolling();
      }
    },

    async stop() {
      stopped = true;
      log.info("[realtime-sync] Stopping Realtime sync");

      stopPolling();
      await unsubscribeFromChannels();
      isConnected = false;
    },

    isConnected() {
      return isConnected;
    },

    isPolling() {
      return pollingTimer !== null;
    },
  };
}
