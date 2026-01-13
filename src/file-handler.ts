import * as fs from "fs";
import * as path from "path";
import type { MattermostClient } from "./clients/mattermost-client.js";
import type { FilesConfig } from "./config.js";
import type { UserSession } from "./session-manager.js";
import { log } from "./logger.js";

export class FileHandler {
  private mmClient: MattermostClient;
  private config: FilesConfig;
  private tempFiles: Set<string> = new Set();

  constructor(mmClient: MattermostClient, config: FilesConfig) {
    this.mmClient = mmClient;
    this.config = config;
    this.ensureTempDir();
  }

  private ensureTempDir(): void {
    if (!fs.existsSync(this.config.tempDir)) {
      fs.mkdirSync(this.config.tempDir, { recursive: true });
    }
  }

  async processInboundAttachments(fileIds: string[]): Promise<string[]> {
    const filePaths: string[] = [];

    for (const fileId of fileIds) {
      try {
        const fileInfo = await this.mmClient.getFileInfo(fileId);

        if (fileInfo.size > this.config.maxFileSize) {
          log.warn(`[FileHandler] File ${fileInfo.name} exceeds max size, skipping`);
          continue;
        }

        if (
          this.config.allowedExtensions[0] !== "*" &&
          !this.config.allowedExtensions.includes(fileInfo.extension)
        ) {
          log.warn(`[FileHandler] File extension ${fileInfo.extension} not allowed, skipping`);
          continue;
        }

        const fileData = await this.mmClient.downloadFile(fileId);
        const tempFileName = `${Date.now()}-${fileInfo.name}`;
        const tempFilePath = path.join(this.config.tempDir, tempFileName);

        fs.writeFileSync(tempFilePath, fileData);
        this.tempFiles.add(tempFilePath);
        filePaths.push(tempFilePath);

        log.debug(`[FileHandler] Downloaded file: ${fileInfo.name} -> ${tempFilePath}`);
      } catch (error) {
        log.error(`[FileHandler] Failed to process file ${fileId}:`, error);
      }
    }

    return filePaths;
  }

  async sendOutboundFile(
    session: UserSession,
    filePath: string,
    message?: string
  ): Promise<void> {
    try {
      const fileName = path.basename(filePath);
      const fileData = fs.readFileSync(filePath);
      const mimeType = this.getMimeType(filePath);

      const uploadResult = await this.mmClient.uploadFile(
        session.dmChannelId,
        fileName,
        fileData,
        mimeType
      );

      const fileIds = uploadResult.file_infos.map((f) => f.id);
      const displayMessage = message || `File: \`${fileName}\``;

      await this.mmClient.createPost(session.dmChannelId, displayMessage, undefined, fileIds);

      log.debug(`[FileHandler] Sent file: ${fileName}`);
    } catch (error) {
      log.error(`[FileHandler] Failed to send file ${filePath}:`, error);
      throw error;
    }
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".js": "application/javascript",
      ".ts": "application/typescript",
      ".py": "text/x-python",
      ".html": "text/html",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  cleanupTempFiles(): void {
    for (const filePath of this.tempFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          log.debug(`[FileHandler] Cleaned up temp file: ${filePath}`);
        }
      } catch (error) {
        log.error(`[FileHandler] Failed to cleanup temp file ${filePath}:`, error);
      }
    }
    this.tempFiles.clear();
  }

  cleanupSessionFiles(session: UserSession): void {
    this.cleanupTempFiles();
  }
}
