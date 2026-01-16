import { z } from "zod";

export const ThreadSessionMappingSchema = z.object({
  sessionId: z.string().min(1),
  threadRootPostId: z.string().min(1),
  shortId: z.string().min(6).max(10),
  mattermostUserId: z.string().min(1),
  dmChannelId: z.string().min(1),
  projectName: z.string().min(1),
  directory: z.string().min(1),
  sessionTitle: z.string().optional(),
  status: z.enum(["active", "ended", "disconnected", "orphaned"]),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
});

export const ThreadMappingFileSchema = z.object({
  version: z.literal(1),
  mappings: z.array(ThreadSessionMappingSchema),
  lastModified: z.string().datetime(),
});

export type ThreadMappingFileV1 = z.infer<typeof ThreadMappingFileSchema>;
