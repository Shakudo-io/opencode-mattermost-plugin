import type { ParsedCommand } from "../message-router.js";

export interface ThreadPromptRoute {
  type: "thread_prompt";
  sessionId: string;
  threadRootPostId: string;
  promptText: string;
  fileIds?: string[];
}

export interface MainDmCommandRoute {
  type: "main_dm_command";
  command: ParsedCommand;
}

export interface MainDmPromptRoute {
  type: "main_dm_prompt";
  errorMessage: string;
  suggestedAction: string;
}

export interface UnknownThreadRoute {
  type: "unknown_thread";
  threadRootPostId: string;
  errorMessage: string;
}

export interface EndedSessionRoute {
  type: "ended_session";
  sessionId: string;
  threadRootPostId: string;
  errorMessage: string;
}

export type InboundRouteResult =
  | ThreadPromptRoute
  | MainDmCommandRoute
  | MainDmPromptRoute
  | UnknownThreadRoute
  | EndedSessionRoute;
