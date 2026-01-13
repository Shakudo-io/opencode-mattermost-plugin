import axios, { AxiosInstance } from "axios";
import type { MattermostConfig } from "../config.js";
import type { User, Team, Channel, Post, PostList, FileInfo } from "../models/index.js";
import { log as fileLog } from "../logger.js";

export class MattermostClient {
  private config: MattermostConfig;
  public client: AxiosInstance;
  private token: string | null = null;
  private debug: boolean;

  constructor(config: MattermostConfig) {
    this.config = config;
    this.token = config.token || null;
    this.debug = config.debug || false;

    if (!this.config.baseUrl.startsWith("http://") && !this.config.baseUrl.startsWith("https://")) {
      throw new Error(`Invalid baseUrl format: ${this.config.baseUrl} - URL must start with http:// or https://`);
    }

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (this.token) {
      this.setAuthHeader(this.token);
    }

    this.log("Mattermost client initialized with base URL:", this.config.baseUrl);
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      fileLog.debug(`[Client] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`);
    }
  }

  private setAuthHeader(token: string): void {
    if (!token) return;
    this.token = token;
    this.client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  }

  async testConnection(): Promise<any> {
    const response = await this.client.get("/system/ping");
    return response.data;
  }

  async getCurrentUser(): Promise<User> {
    const response = await this.client.get("/users/me");
    if (response.status >= 400) {
      throw new Error(`Failed to get current user: ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async getUserByUsername(username: string): Promise<User> {
    const response = await this.client.get(`/users/username/${username}`);
    if (response.status >= 400) {
      throw new Error(`Failed to get user '${username}': ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async getUserById(userId: string): Promise<User> {
    const response = await this.client.get(`/users/${userId}`);
    if (response.status >= 400) {
      throw new Error(`Failed to get user: ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async getTeams(): Promise<Team[]> {
    const response = await this.client.get("/teams");
    return response.data;
  }

  async getChannel(channelId: string): Promise<Channel> {
    const response = await this.client.get(`/channels/${channelId}`);
    if (response.status >= 400) {
      throw new Error(`Failed to get channel: ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async createDirectChannel(userId: string): Promise<Channel> {
    const currentUser = await this.getCurrentUser();
    const response = await this.client.post("/channels/direct", [currentUser.id, userId]);
    if (response.status >= 400) {
      throw new Error(`Failed to create direct channel: ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async createPost(channelId: string, message: string, rootId?: string, fileIds?: string[]): Promise<Post> {
    const payload: any = {
      channel_id: channelId,
      message,
    };

    if (rootId) payload.root_id = rootId;
    if (fileIds) payload.file_ids = fileIds;

    this.log(`Creating post in channel: ${channelId}`);
    const response = await this.client.post("/posts", payload);

    if (response.status >= 400) {
      throw new Error(`Failed to create post: ${JSON.stringify(response.data)}`);
    }

    return response.data;
  }

  async updatePost(postId: string, message: string): Promise<Post> {
    this.log(`Updating post: ${postId}`);
    const response = await this.client.put(`/posts/${postId}`, {
      id: postId,
      message,
    });

    if (response.status >= 400) {
      throw new Error(`Failed to update post: ${JSON.stringify(response.data)}`);
    }

    return response.data;
  }

  async getPosts(channelId: string, page = 0, perPage = 60): Promise<PostList> {
    const response = await this.client.get(`/channels/${channelId}/posts`, {
      params: { page, per_page: perPage },
    });
    return response.data;
  }

  async getPost(postId: string): Promise<Post> {
    const response = await this.client.get(`/posts/${postId}`);
    if (response.status >= 400) {
      throw new Error(`Failed to get post: ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async getPostThread(postId: string): Promise<PostList> {
    const response = await this.client.get(`/posts/${postId}/thread`);
    return response.data;
  }

  async addReaction(postId: string, emojiName: string): Promise<any> {
    const currentUser = await this.getCurrentUser();
    const response = await this.client.post("/reactions", {
      user_id: currentUser.id,
      post_id: postId,
      emoji_name: emojiName,
    });
    return response.data;
  }

  async getReactions(postId: string): Promise<any[]> {
    const response = await this.client.get(`/posts/${postId}/reactions`);
    return response.data || [];
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

    const response = await this.client.post("/files", formData, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "multipart/form-data",
      },
    });

    return response.data;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const response = await this.client.get(`/files/${fileId}`, {
      responseType: "arraybuffer",
    });
    return Buffer.from(response.data);
  }

  async getFileInfo(fileId: string): Promise<FileInfo> {
    const response = await this.client.get(`/files/${fileId}/info`);
    return response.data;
  }
}
