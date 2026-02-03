import { z } from "zod";

export const InstanceStatusSchema = z.enum(["active", "dead", "draining"]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

export const InstanceSchema = z.object({
  instance_id: z.string().max(64),
  hostname: z.string().max(255).nullable(),
  started_at: z.coerce.date(),
  last_heartbeat: z.coerce.date(),
  status: InstanceStatusSchema,
  is_leader: z.boolean(),
  version: z.string().max(32).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type Instance = z.infer<typeof InstanceSchema>;

export const InstanceInsertSchema = InstanceSchema.omit({
  started_at: true,
  last_heartbeat: true,
}).partial({
  status: true,
  is_leader: true,
  hostname: true,
  version: true,
  metadata: true,
});
export type InstanceInsert = z.infer<typeof InstanceInsertSchema>;

export const ThreadModeSchema = z.enum(["normal", "takeover", "none"]);
export type ThreadMode = z.infer<typeof ThreadModeSchema>;

// Metadata schema for extra ThreadSessionMapping fields not in core DB schema
export const ThreadMappingMetadataSchema = z.object({
  shortId: z.string().optional(),
  dmChannelId: z.string().optional(),
  projectName: z.string().optional(),
  directory: z.string().optional(),
  sessionTitle: z.string().optional(),
  status: z.enum(["active", "ended", "disconnected", "orphaned", "merged"]).optional(),
  endedAt: z.string().optional(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
    displayName: z.string().optional(),
  }).optional(),
  pendingModelSelection: z.boolean().optional(),
  approvedUsers: z.array(z.string()).optional(),
  approveAllUsers: z.boolean().optional(),
  approveNextMessage: z.boolean().optional(),
  mergedInto: z.string().optional(),
  mergedAt: z.string().optional(),
});
export type ThreadMappingMetadata = z.infer<typeof ThreadMappingMetadataSchema>;

export const ThreadMappingSchema = z.object({
  id: z.number(),
  thread_root_post_id: z.string().max(64),
  channel_id: z.string().max(64),
  opencode_session_id: z.string().max(64),
  mattermost_user_id: z.string().max(64),
  mode: ThreadModeSchema,
  claimed_by: z.string().max(64).nullable(),
  claimed_until: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  metadata: ThreadMappingMetadataSchema.nullable(),
});
export type ThreadMapping = z.infer<typeof ThreadMappingSchema>;

export const ThreadMappingInsertSchema = ThreadMappingSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).partial({
  mode: true,
  claimed_by: true,
  claimed_until: true,
});
export type ThreadMappingInsert = z.infer<typeof ThreadMappingInsertSchema>;

export const ScheduleSchema = z.object({
  id: z.number(),
  name: z.string().max(255),
  cron_expression: z.string().max(100),
  timezone: z.string().max(64),
  prompt: z.string(),
  target_user_id: z.string().max(64),
  enabled: z.boolean(),
  last_run_at: z.coerce.date().nullable(),
  next_run_at: z.coerce.date().nullable(),
  created_by: z.string().max(64),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleInsertSchema = ScheduleSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).partial({
  timezone: true,
  enabled: true,
  last_run_at: true,
  next_run_at: true,
});
export type ScheduleInsert = z.infer<typeof ScheduleInsertSchema>;

export const TeamSchema = z.object({
  team_id: z.string().max(64),
  team_name: z.string().max(255).nullable(),
  opencode_project_path: z.string().max(1024).nullable(),
  default_model: z.string().max(128).nullable(),
  settings: z.record(z.string(), z.unknown()),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Team = z.infer<typeof TeamSchema>;

export const TeamInsertSchema = TeamSchema.omit({
  created_at: true,
  updated_at: true,
}).partial({
  team_name: true,
  opencode_project_path: true,
  default_model: true,
  settings: true,
});
export type TeamInsert = z.infer<typeof TeamInsertSchema>;

export const TeamMemberRoleSchema = z.enum(["admin", "member", "guest"]);
export type TeamMemberRole = z.infer<typeof TeamMemberRoleSchema>;

export const TeamMemberSchema = z.object({
  id: z.number(),
  team_id: z.string().max(64),
  mattermost_user_id: z.string().max(64),
  username: z.string().max(255).nullable(),
  role: TeamMemberRoleSchema,
  is_allowed: z.boolean(),
  created_at: z.coerce.date(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamMemberInsertSchema = TeamMemberSchema.omit({
  id: true,
  created_at: true,
}).partial({
  username: true,
  role: true,
  is_allowed: true,
});
export type TeamMemberInsert = z.infer<typeof TeamMemberInsertSchema>;

export const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const QuestionDataSchema = z.object({
  header: z.string(),
  question: z.string(),
  options: z.array(QuestionOptionSchema),
  multiple: z.boolean().optional(),
});
export type QuestionData = z.infer<typeof QuestionDataSchema>;

export const PendingQuestionStatusSchema = z.enum(["pending", "answered", "expired"]);
export type PendingQuestionStatus = z.infer<typeof PendingQuestionStatusSchema>;

export const PendingQuestionSchema = z.object({
  id: z.string().max(64),
  thread_root_post_id: z.string().max(64),
  opencode_session_id: z.string().max(64),
  question_post_id: z.string().max(64),
  question_data: QuestionDataSchema,
  status: PendingQuestionStatusSchema,
  answer: z.string().nullable(),
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  answered_at: z.coerce.date().nullable(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const PendingQuestionInsertSchema = PendingQuestionSchema.omit({
  created_at: true,
  expires_at: true,
}).partial({
  status: true,
  answer: true,
  answered_at: true,
});
export type PendingQuestionInsert = z.infer<typeof PendingQuestionInsertSchema>;

export const PendingApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);
export type PendingApprovalStatus = z.infer<typeof PendingApprovalStatusSchema>;

export const PendingApprovalSchema = z.object({
  id: z.string().max(64),
  guest_user_id: z.string().max(64),
  guest_username: z.string().max(255).nullable(),
  approval_post_id: z.string().max(64),
  channel_id: z.string().max(64),
  session_id: z.string().max(64),
  thread_root_post_id: z.string().max(64),
  original_message: z.string().nullable(),
  status: PendingApprovalStatusSchema,
  decided_by: z.string().max(64).nullable(),
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  decided_at: z.coerce.date().nullable(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const PendingApprovalInsertSchema = PendingApprovalSchema.omit({
  created_at: true,
  expires_at: true,
}).partial({
  guest_username: true,
  status: true,
  decided_by: true,
  decided_at: true,
  original_message: true,
});
export type PendingApprovalInsert = z.infer<typeof PendingApprovalInsertSchema>;

export const PendingOwnershipStatusSchema = z.enum(["pending", "confirmed", "rejected", "expired"]);
export type PendingOwnershipStatus = z.infer<typeof PendingOwnershipStatusSchema>;

export const PendingOwnershipStepSchema = z.enum(["confirm_create", "select_approval"]);
export type PendingOwnershipStep = z.infer<typeof PendingOwnershipStepSchema>;

export const PendingOwnershipSchema = z.object({
  id: z.string().max(64),
  thread_root_post_id: z.string().max(64),
  channel_id: z.string().max(64),
  claiming_user_id: z.string().max(64),
  current_owner_id: z.string().max(64).nullable(),
  confirmation_post_id: z.string().max(64),
  step: PendingOwnershipStepSchema,
  status: PendingOwnershipStatusSchema,
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  resolved_at: z.coerce.date().nullable(),
});
export type PendingOwnership = z.infer<typeof PendingOwnershipSchema>;

export const PendingOwnershipInsertSchema = PendingOwnershipSchema.omit({
  created_at: true,
  expires_at: true,
}).partial({
  status: true,
  resolved_at: true,
  current_owner_id: true,
});
export type PendingOwnershipInsert = z.infer<typeof PendingOwnershipInsertSchema>;
