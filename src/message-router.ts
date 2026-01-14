import type { Post } from "./models/index.js";

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

export class MessageRouter {
  private commandPrefix: string;

  constructor(commandPrefix: string = "!") {
    this.commandPrefix = commandPrefix;
  }

  route(post: Post): RouteResult {
    const message = post.message.trim();
    
    if (this.isCommand(message)) {
      return {
        type: "command",
        command: this.parseCommand(message),
      };
    }

    return {
      type: "prompt",
      promptText: message,
    };
  }

  private isCommand(message: string): boolean {
    return message.startsWith(this.commandPrefix);
  }

  private parseCommand(message: string): ParsedCommand {
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
