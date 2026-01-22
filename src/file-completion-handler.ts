/**
 * File Completion Handler
 * 
 * Provides file path completion via !! trigger in Mattermost messages.
 * Since Mattermost doesn't stream keystrokes, this uses a post-send
 * disambiguation flow:
 * 
 * 1. User sends: "Look at !!src/resp"
 * 2. Bot parses !! references and calls OpenCode /find/file API
 * 3. If exact match: auto-attach file content
 * 4. If fuzzy matches: prompt user to select from options
 * 5. User replies with number(s) to resolve
 * 6. Bot processes original message with resolved file contents
 */

import { log } from "./logger.js";

/** Pattern to match !!<path> references */
const FILE_REFERENCE_PATTERN = /!!([^\s`]+)/g;

/** Pattern to match code blocks (to skip !! inside them) */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```|`[^`]+`/g;

export interface FileMatch {
  path: string;
  score: number;
}

export interface FileReference {
  /** The original !! reference (e.g., "!!src/resp") */
  original: string;
  /** The query part without !! prefix (e.g., "src/resp") */
  query: string;
  /** Matched files from the API */
  matches: FileMatch[];
  /** Resolved file path (if exact match or user selected) */
  resolvedPath?: string;
}

export interface PendingFileCompletion {
  /** Session ID this completion is for */
  sessionId: string;
  /** Thread root post ID */
  threadRootPostId: string;
  /** Channel ID */
  channelId: string;
  /** Original message text */
  originalMessage: string;
  /** File references that need resolution */
  references: FileReference[];
  /** User ID who sent the message */
  userId: string;
  /** Timestamp when the completion was requested */
  createdAt: Date;
  /** Post ID of the disambiguation prompt */
  disambiguationPostId?: string;
  /** File IDs from original message */
  fileIds?: string[];
}

export interface FileCompletionResult {
  /** Whether all references were resolved */
  allResolved: boolean;
  /** The message with file references replaced/resolved */
  processedMessage: string;
  /** File paths that were resolved and should be attached */
  resolvedFilePaths: string[];
  /** Whether disambiguation is needed */
  needsDisambiguation: boolean;
  /** References that need user input */
  unresolvedReferences: FileReference[];
}

export class FileCompletionHandler {
  /** Pending completions by session ID */
  private pendingCompletions: Map<string, PendingFileCompletion> = new Map();
  
  /** OpenCode server base URL */
  private opencodeBaseUrl: string;
  
  /** Project directory for file searches */
  private directory: string;
  
  constructor(opencodeBaseUrl: string, directory: string) {
    this.opencodeBaseUrl = opencodeBaseUrl;
    this.directory = directory;
  }

  /**
   * Check if a message contains !! file references
   */
  hasFileReferences(message: string): boolean {
    // First, remove code blocks to avoid matching !! inside code
    const withoutCodeBlocks = message.replace(CODE_BLOCK_PATTERN, "");
    return FILE_REFERENCE_PATTERN.test(withoutCodeBlocks);
  }

  /**
   * Extract all !! file references from a message
   */
  extractFileReferences(message: string): string[] {
    // Remove code blocks first
    const withoutCodeBlocks = message.replace(CODE_BLOCK_PATTERN, "");
    
    const references: string[] = [];
    let match;
    
    // Reset regex state
    FILE_REFERENCE_PATTERN.lastIndex = 0;
    
    while ((match = FILE_REFERENCE_PATTERN.exec(withoutCodeBlocks)) !== null) {
      references.push(match[1]); // The query part without !!
    }
    
    // Deduplicate
    return [...new Set(references)];
  }

  /**
   * Search for files matching a query using OpenCode's /find/file API
   */
  async searchFiles(query: string, limit: number = 5): Promise<FileMatch[]> {
    try {
      const url = `${this.opencodeBaseUrl}/find/file?query=${encodeURIComponent(query)}&limit=${limit}`;
      
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": this.directory,
        },
      });
      
      if (!response.ok) {
        log.error(`[FileCompletion] Search failed: HTTP ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      
      // API returns a plain array of strings, not { files: [...] }
      if (!Array.isArray(data)) {
        log.debug(`[FileCompletion] Unexpected response format for query: ${query}`, data);
        return [];
      }
      
      if (data.length === 0) {
        log.debug(`[FileCompletion] No files returned for query: ${query}`);
        return [];
      }
      
      log.debug(`[FileCompletion] Found ${data.length} files for query: ${query}`);
      
      return data.map((path: string) => ({
        path,
        score: 0,  // API doesn't return scores
      }));
    } catch (error) {
      log.error(`[FileCompletion] Search error:`, error);
      return [];
    }
  }

  /**
   * Process a message with file references
   * Returns a result indicating if disambiguation is needed
   */
  async processMessage(
    sessionId: string,
    threadRootPostId: string,
    channelId: string,
    message: string,
    userId: string,
    fileIds?: string[]
  ): Promise<FileCompletionResult> {
    const queries = this.extractFileReferences(message);
    
    if (queries.length === 0) {
      return {
        allResolved: true,
        processedMessage: message,
        resolvedFilePaths: [],
        needsDisambiguation: false,
        unresolvedReferences: [],
      };
    }
    
    log.info(`[FileCompletion] Found ${queries.length} file reference(s): ${queries.join(", ")}`);
    
    const references: FileReference[] = [];
    const resolvedFilePaths: string[] = [];
    const unresolvedReferences: FileReference[] = [];
    
    // Search for each reference
    for (const query of queries) {
      const matches = await this.searchFiles(query);
      
      const reference: FileReference = {
        original: `!!${query}`,
        query,
        matches,
      };
      
      // Check for exact match (score = 0 means perfect match in fuzzysort)
      // Or if there's only one result with a very high score
      const exactMatch = matches.find(m => 
        m.path.toLowerCase() === query.toLowerCase() ||
        m.path.toLowerCase().endsWith(`/${query.toLowerCase()}`) ||
        m.path.toLowerCase().endsWith(`\\${query.toLowerCase()}`)
      );
      
      if (exactMatch) {
        reference.resolvedPath = exactMatch.path;
        resolvedFilePaths.push(exactMatch.path);
        log.info(`[FileCompletion] Exact match for "${query}": ${exactMatch.path}`);
      } else if (matches.length === 1) {
        // Single fuzzy match - auto-resolve
        reference.resolvedPath = matches[0].path;
        resolvedFilePaths.push(matches[0].path);
        log.info(`[FileCompletion] Single match for "${query}": ${matches[0].path}`);
      } else if (matches.length === 0) {
        log.info(`[FileCompletion] No matches for "${query}"`);
        unresolvedReferences.push(reference);
      } else {
        // Multiple matches - needs disambiguation
        log.info(`[FileCompletion] Multiple matches for "${query}": ${matches.length} options`);
        unresolvedReferences.push(reference);
      }
      
      references.push(reference);
    }
    
    const needsDisambiguation = unresolvedReferences.length > 0;
    
    if (needsDisambiguation) {
      // Store pending completion for later resolution
      const pending: PendingFileCompletion = {
        sessionId,
        threadRootPostId,
        channelId,
        originalMessage: message,
        references,
        userId,
        createdAt: new Date(),
        fileIds,
      };
      this.pendingCompletions.set(sessionId, pending);
      log.info(`[FileCompletion] Stored pending completion for session ${sessionId.substring(0, 8)}`);
    }
    
    // Build processed message with resolved paths
    let processedMessage = message;
    for (const ref of references) {
      if (ref.resolvedPath) {
        // Replace !!query with the resolved path (without !!)
        processedMessage = processedMessage.replace(ref.original, ref.resolvedPath);
      }
    }
    
    return {
      allResolved: !needsDisambiguation,
      processedMessage,
      resolvedFilePaths,
      needsDisambiguation,
      unresolvedReferences,
    };
  }

  /**
   * Format disambiguation prompt for the user
   */
  formatDisambiguationPrompt(unresolvedReferences: FileReference[]): string {
    const lines: string[] = [
      ":file_folder: **File suggestions**",
      "",
    ];
    
    let globalIndex = 1;
    const indexMap: Map<number, { reference: FileReference; matchIndex: number }> = new Map();
    
    for (const ref of unresolvedReferences) {
      lines.push(`**\`${ref.original}\`**:`);
      
      if (ref.matches.length === 0) {
        lines.push(`  _No files found matching "${ref.query}"_`);
      } else {
        for (let i = 0; i < ref.matches.length; i++) {
          const match = ref.matches[i];
          lines.push(`  \`${globalIndex}\`. ${match.path}`);
          indexMap.set(globalIndex, { reference: ref, matchIndex: i });
          globalIndex++;
        }
      }
      lines.push("");
    }
    
    lines.push("---");
    lines.push("_Reply with number(s) to select (e.g., `1` or `1, 3`)_");
    lines.push("_Or type `!cancel` to skip file completion_");
    
    return lines.join("\n");
  }

  /**
   * Check if there's a pending file completion for a session
   */
  hasPendingCompletion(sessionId: string): boolean {
    const pending = this.pendingCompletions.get(sessionId);
    if (!pending) return false;
    
    // Expire after 30 minutes
    const ageMs = Date.now() - pending.createdAt.getTime();
    if (ageMs > 30 * 60 * 1000) {
      this.pendingCompletions.delete(sessionId);
      return false;
    }
    
    return true;
  }

  /**
   * Get pending completion for a session
   */
  getPendingCompletion(sessionId: string): PendingFileCompletion | null {
    return this.pendingCompletions.get(sessionId) || null;
  }

  /**
   * Set the disambiguation post ID for tracking
   */
  setDisambiguationPostId(sessionId: string, postId: string): void {
    const pending = this.pendingCompletions.get(sessionId);
    if (pending) {
      pending.disambiguationPostId = postId;
    }
  }

  /**
   * Handle user's reply to disambiguation prompt
   * 
   * @param sessionId - Session ID
   * @param reply - User's reply (numbers or !cancel)
   * @returns Resolved result or null if cancelled
   */
  handleDisambiguationReply(
    sessionId: string,
    reply: string
  ): { resolved: boolean; result?: FileCompletionResult; cancelled?: boolean } {
    const pending = this.pendingCompletions.get(sessionId);
    if (!pending) {
      return { resolved: false };
    }
    
    const trimmedReply = reply.trim().toLowerCase();
    
    // Check for cancel
    if (trimmedReply === "!cancel" || trimmedReply === "cancel") {
      this.pendingCompletions.delete(sessionId);
      log.info(`[FileCompletion] User cancelled file completion for session ${sessionId.substring(0, 8)}`);
      return { resolved: true, cancelled: true };
    }
    
    // Parse number selections (e.g., "1" or "1, 3" or "1,3")
    const selections = trimmedReply
      .split(/[,\s]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
    
    if (selections.length === 0) {
      // Not a valid selection, might be a regular message
      return { resolved: false };
    }
    
    // Build global index map
    let globalIndex = 1;
    const indexMap: Map<number, { reference: FileReference; match: FileMatch }> = new Map();
    
    for (const ref of pending.references) {
      if (!ref.resolvedPath && ref.matches.length > 0) {
        for (const match of ref.matches) {
          indexMap.set(globalIndex, { reference: ref, match });
          globalIndex++;
        }
      }
    }
    
    // Validate all selections
    for (const sel of selections) {
      if (!indexMap.has(sel)) {
        log.warn(`[FileCompletion] Invalid selection ${sel}, max is ${globalIndex - 1}`);
        return { resolved: false };
      }
    }
    
    // Apply selections
    const resolvedFilePaths: string[] = [];
    
    for (const sel of selections) {
      const { reference, match } = indexMap.get(sel)!;
      reference.resolvedPath = match.path;
      resolvedFilePaths.push(match.path);
      log.info(`[FileCompletion] User selected ${sel}: ${match.path} for "${reference.query}"`);
    }
    
    // Add previously resolved paths
    for (const ref of pending.references) {
      if (ref.resolvedPath && !resolvedFilePaths.includes(ref.resolvedPath)) {
        resolvedFilePaths.push(ref.resolvedPath);
      }
    }
    
    // Check if all references are now resolved
    const stillUnresolved = pending.references.filter(r => !r.resolvedPath && r.matches.length > 0);
    
    if (stillUnresolved.length > 0) {
      // Still needs more disambiguation
      return { resolved: false };
    }
    
    // Build final processed message
    let processedMessage = pending.originalMessage;
    for (const ref of pending.references) {
      if (ref.resolvedPath) {
        processedMessage = processedMessage.replace(ref.original, ref.resolvedPath);
      } else if (ref.matches.length === 0) {
        // No matches found - leave as is or remove
        processedMessage = processedMessage.replace(ref.original, `[file not found: ${ref.query}]`);
      }
    }
    
    this.pendingCompletions.delete(sessionId);
    
    return {
      resolved: true,
      result: {
        allResolved: true,
        processedMessage,
        resolvedFilePaths,
        needsDisambiguation: false,
        unresolvedReferences: [],
      },
    };
  }

  /**
   * Clear pending completion for a session
   */
  clearPendingCompletion(sessionId: string): void {
    this.pendingCompletions.delete(sessionId);
  }

  /**
   * Read file content from the project
   * Uses OpenCode's file reading endpoint or direct fs
   */
  async readFileContent(filePath: string): Promise<string | null> {
    try {
      // Use OpenCode's file content endpoint
      const url = `${this.opencodeBaseUrl}/file/content?path=${encodeURIComponent(filePath)}`;
      
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": this.directory,
        },
      });
      
      if (!response.ok) {
        log.error(`[FileCompletion] Failed to read file ${filePath}: HTTP ${response.status}`);
        return null;
      }
      
      const data = await response.json() as { content?: string };
      return data.content || null;
    } catch (error) {
      log.error(`[FileCompletion] Error reading file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Format file content for inclusion in prompt
   */
  formatFileContentForPrompt(filePath: string, content: string): string {
    // Determine language hint from extension
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const langHints: Record<string, string> = {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      cpp: "cpp",
      c: "c",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      sh: "bash",
      bash: "bash",
      zsh: "zsh",
      yaml: "yaml",
      yml: "yaml",
      json: "json",
      md: "markdown",
      sql: "sql",
      css: "css",
      scss: "scss",
      html: "html",
      xml: "xml",
    };
    
    const lang = langHints[ext] || "";
    
    return `\n\n📁 **File: \`${filePath}\`**\n\`\`\`${lang}\n${content}\n\`\`\``;
  }
}
