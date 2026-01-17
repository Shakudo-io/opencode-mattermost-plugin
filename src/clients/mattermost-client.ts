import type { MattermostConfig } from "../config.js";
import type { User, Team, Channel, Post, PostList, FileInfo } from "../models/index.js";
import { log as fileLog } from "../logger.js";

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
}

export class MattermostClient {
  private config: MattermostConfig;
  private baseUrl: string;
  private token: string | null = null;
  private debug: boolean;

  constructor(config: MattermostConfig) {
    this.config = config;
    this.token = config.token || null;
    this.debug = config.debug || false;

    if (!this.config.baseUrl.startsWith("http://") && !this.config.baseUrl.startsWith("https://")) {
      throw new Error(`Invalid baseUrl format: ${this.config.baseUrl} - URL must start with http:// or https://`);
    }

    this.baseUrl = this.config.baseUrl.replace(/\/$/, "");
    this.log("Mattermost client initialized with base URL:", this.baseUrl);
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      fileLog.debug(`[Client] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`);
    }
  }

  private getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const isFormData = options.body instanceof FormData;
    
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        ...this.getHeaders(isFormData ? undefined : "application/json"),
        ...options.headers,
      },
      body: options.body,
    });

    if (response.status >= 400) {
      const errorData = await response.text();
      throw new Error(`Request failed (${response.status}): ${errorData}`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return response.json() as Promise<T>;
    }
    
    return response.text() as unknown as T;
  }

  private async requestArrayBuffer(path: string): Promise<Buffer> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (response.status >= 400) {
      const errorData = await response.text();
      throw new Error(`Request failed (${response.status}): ${errorData}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async testConnection(): Promise<any> {
    return this.request("/system/ping");
  }

  async getCurrentUser(): Promise<User> {
    return this.request<User>("/users/me");
  }

  async getUserByUsername(username: string): Promise<User> {
    return this.request<User>(`/users/username/${username}`);
  }

  async getUserById(userId: string): Promise<User> {
    return this.request<User>(`/users/${userId}`);
  }

  async getTeams(): Promise<Team[]> {
    return this.request<Team[]>("/teams");
  }

  async getChannel(channelId: string): Promise<Channel> {
    return this.request<Channel>(`/channels/${channelId}`);
  }

  async createDirectChannel(userId: string): Promise<Channel> {
    const currentUser = await this.getCurrentUser();
    return this.request<Channel>("/channels/direct", {
      method: "POST",
      body: JSON.stringify([currentUser.id, userId]),
    });
  }

  async createPost(channelId: string, message: string, rootId?: string, fileIds?: string[]): Promise<Post> {
    const payload: any = {
      channel_id: channelId,
      message,
    };

    if (rootId) payload.root_id = rootId;
    if (fileIds) payload.file_ids = fileIds;

    this.log(`Creating post in channel: ${channelId}`);
    return this.request<Post>("/posts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async updatePost(postId: string, message: string): Promise<Post> {
    this.log(`Updating post: ${postId}`);
    return this.request<Post>(`/posts/${postId}`, {
      method: "PUT",
      body: JSON.stringify({ id: postId, message }),
    });
  }

  async deletePost(postId: string): Promise<void> {
    this.log(`Deleting post: ${postId}`);
    await this.request(`/posts/${postId}`, { method: "DELETE" });
  }

  async getPosts(channelId: string, page = 0, perPage = 60): Promise<PostList> {
    return this.request<PostList>(`/channels/${channelId}/posts?page=${page}&per_page=${perPage}`);
  }

  async getPost(postId: string): Promise<Post> {
    return this.request<Post>(`/posts/${postId}`);
  }

  async getPostThread(postId: string): Promise<PostList> {
    return this.request<PostList>(`/posts/${postId}/thread`);
  }

  async addReaction(postId: string, emojiName: string): Promise<any> {
    const currentUser = await this.getCurrentUser();
    return this.request("/reactions", {
      method: "POST",
      body: JSON.stringify({
        user_id: currentUser.id,
        post_id: postId,
        emoji_name: emojiName,
      }),
    });
  }

  async getReactions(postId: string): Promise<any[]> {
    const result = await this.request<any[]>(`/posts/${postId}/reactions`);
    return result || [];
  }

  async uploadFile(
    channelId: string,
    fileName: string,
    fileData: Buffer,
    contentType: string
  ): Promise<{ file_infos: FileInfo[]; client_ids: string[] }> {
    this.log(`Uploading file ${fileName} to channel ${channelId}`);

    const formData = new FormData();
    formData.append("files", new Blob([new Uint8Array(fileData)], { type: contentType }), fileName);
    formData.append("channel_id", channelId);

    const url = `${this.baseUrl}/files`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
      },
      body: formData,
    });

    if (response.status >= 400) {
      const errorData = await response.text();
      throw new Error(`Failed to upload file: ${errorData}`);
    }

    return response.json();
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    return this.requestArrayBuffer(`/files/${fileId}`);
  }

  async getFileInfo(fileId: string): Promise<FileInfo> {
    return this.request<FileInfo>(`/files/${fileId}/info`);
  }
}
