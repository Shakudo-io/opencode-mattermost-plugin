export interface User {
  id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  username: string;
  auth_service: string;
  email: string;
  nickname: string;
  first_name: string;
  last_name: string;
  position: string;
  roles: string;
  allow_marketing: boolean;
  props: Record<string, any>;
  notify_props: {
    email: string;
    push: string;
    desktop: string;
    desktop_sound: string;
    mention_keys: string;
    channel: string;
    first_name: string;
  };
  last_password_update: number;
  locale: string;
  timezone?: {
    automaticTimezone: string;
    manualTimezone: string;
    useAutomaticTimezone: string;
  };
  is_bot: boolean;
}

export interface Team {
  id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  display_name: string;
  name: string;
  description: string;
  email: string;
  type: string;
  company_name: string;
  allowed_domains: string;
  invite_id: string;
  allow_open_invite: boolean;
  scheme_id: string;
  group_constrained: boolean;
}

export interface Channel {
  id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  team_id: string;
  type: string;
  display_name: string;
  name: string;
  header: string;
  purpose: string;
  last_post_at: number;
  total_msg_count: number;
  extra_update_at: number;
  creator_id: string;
  scheme_id: string;
  group_constrained: boolean;
}

export interface Post {
  id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  edit_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  parent_id: string;
  original_id: string;
  message: string;
  type: string;
  props: Record<string, any>;
  hashtags: string;
  file_ids: string[];
  pending_post_id: string;
  metadata: {
    embeds?: any[];
    emojis?: any[];
    files?: any[];
    images?: {
      height: number;
      width: number;
      format: string;
      frame_count: number;
    }[];
    reactions?: any[];
  };
}

export interface PostList {
  order: string[];
  posts: Record<string, Post>;
  next_post_id?: string;
  prev_post_id?: string;
}

export interface Reaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

export interface FileInfo {
  id: string;
  user_id: string;
  post_id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  name: string;
  extension: string;
  size: number;
  mime_type: string;
  width: number;
  height: number;
  has_preview_image: boolean;
  mini_preview?: string;
}

export interface WebSocketEvent {
  event: string;
  data: any;
  broadcast: {
    omit_users?: Record<string, boolean>;
    user_id?: string;
    channel_id?: string;
    team_id?: string;
  };
  seq: number;
}

export interface PostedEvent {
  channel_display_name: string;
  channel_name: string;
  channel_type: string;
  mentioned?: Record<string, boolean>;
  post: string;
  sender_name: string;
  set_online?: boolean;
  team_id: string;
  event_name?: string;
}

export type ThreadMappingStatus = "active" | "ended" | "disconnected" | "orphaned";

export interface ThreadSessionMapping {
  sessionId: string;
  threadRootPostId: string;
  shortId: string;
  mattermostUserId: string;
  dmChannelId: string;
  projectName: string;
  directory: string;
  sessionTitle?: string;
  status: ThreadMappingStatus;
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
}

export interface ThreadRootPostContent {
  projectName: string;
  directory: string;
  sessionId: string;
  shortId: string;
  startedAt: Date;
  sessionTitle?: string;
}
