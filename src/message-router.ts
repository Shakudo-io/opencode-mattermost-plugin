import type { Post, ThreadSessionMapping } from "./models/index.js";
import type { 
  InboundRouteResult, 
  ThreadPromptRoute, 
  MainDmCommandRoute, 
  MainDmPromptRoute, 
  UnknownThreadRoute, 
  EndedSessionRoute 
} from "./models/routing.js";

export type MessageType = "command" | "prompt";

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export interface RouteResult {
  type: MessageType;
  command?: ParsedCommand;
  promptText?: string;
}

export type ThreadLookupFn = (threadRootPostId: string) => ThreadSessionMapping | null;

export class MessageRouter {
  private commandPrefix: string;
  private threadLookup: ThreadLookupFn | null = null;

  constructor(commandPrefix: string = "!") {
    this.commandPrefix = commandPrefix;
  }

  setThreadLookup(fn: ThreadLookupFn): void {
    this.threadLookup = fn;
  }

  route(post: Post): RouteResult {
    const message = post.message.trim();
    
    if (this.isCommand(message)) {
      return {
        type: "command",
        command: this.parseCommand(message)!,
      };
    }

    return {
      type: "prompt",
      promptText: message,
    };
  }

  routeWithThreads(post: Post): InboundRouteResult {
    const message = post.message.trim();
    const threadRootPostId = post.root_id;
    
    if (threadRootPostId && this.threadLookup) {
      const mapping = this.threadLookup(threadRootPostId);
      
      if (!mapping) {
        return {
          type: "unknown_thread",
          threadRootPostId,
          errorMessage: "This thread is not associated with any OpenCode session.",
        } as UnknownThreadRoute;
      }
      
      if (mapping.status === "ended") {
        return {
          type: "ended_session",
          sessionId: mapping.sessionId,
          threadRootPostId,
          errorMessage: "This session has ended. Start a new OpenCode session to create a new thread.",
        } as EndedSessionRoute;
      }
      
      if (mapping.status === "disconnected") {
        return {
          type: "ended_session",
          sessionId: mapping.sessionId,
          threadRootPostId,
          errorMessage: "This session is disconnected. Please wait for reconnection or start a new session.",
        } as EndedSessionRoute;
      }
      
      return {
        type: "thread_prompt",
        sessionId: mapping.sessionId,
        threadRootPostId,
        promptText: message,
        fileIds: post.file_ids,
      } as ThreadPromptRoute;
    }
    
    if (this.isCommand(message)) {
      return {
        type: "main_dm_command",
        command: this.parseCommand(message)!,
      } as MainDmCommandRoute;
    }
    
    return {
      type: "main_dm_prompt",
      errorMessage: "Prompts must be sent in a session thread, not the main DM.",
      suggestedAction: "Use `!sessions` to see available sessions and their threads.",
    } as MainDmPromptRoute;
  }

  private isCommand(message: string): boolean {
    return message.startsWith(this.commandPrefix);
  }

  parseCommand(message: string): ParsedCommand | null {
    if (!message.startsWith(this.commandPrefix)) {
      return null;
    }
    const withoutPrefix = message.slice(this.commandPrefix.length);
    const parts = withoutPrefix.split(/\s+/);
    const name = parts[0]?.toLowerCase() || "";
    const args = parts.slice(1);
    const rawArgs = parts.slice(1).join(" ");

    return { name, args, rawArgs };
  }

  getCommandPrefix(): string {
    return this.commandPrefix;
  }
}
