/**
 * Type definitions for the Mattermost Control Plugin
 * 
 * This module contains all TypeScript interfaces used across the plugin.
 * It has NO local imports to prevent circular dependencies.
 */

/**
 * Represents a currently executing tool
 */
export interface ActiveTool {
  name: string;
  startTime: number;
}

/**
 * A task item from OpenCode's todo system
 */
export interface TodoItem {
  id: string;
  content: string;
  status: string;
  priority: string;
}

/**
 * Token usage information
 */
export interface TokenInfo {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

/**
 * Cost and token tracking for a message/session
 */
export interface CostInfo {
  sessionTotal: number;
  currentMessage: number;
  tokens: TokenInfo;
}

/**
 * Per-session context tracking an active response stream
 */
export interface ResponseContext {
  opencodeSessionId: string;
  mmSession: any;
  streamCtx: any;
  threadRootPostId?: string;
  responseBuffer: string;
  thinkingBuffer: string;
  toolCalls: string[];
  activeTool: ActiveTool | null;
  shellOutput: string;
  shellOutputLastUpdate: number;
  lastUpdateTime: number;
  textPartCount?: number;
  reasoningPartCount?: number;
  compactionCount: number;
  todos: TodoItem[];
  cost: CostInfo;
  responseStartTime: number;
  compactionPostId?: string;
  awaitingContinuation: boolean;
  inCompactionSummary: boolean;
}

/**
 * Creates a new empty ResponseContext
 */
export function createEmptyResponseContext(
  opencodeSessionId: string,
  mmSession: any,
  streamCtx: any,
  threadRootPostId?: string,
  sessionTotalCost: number = 0
): ResponseContext {
  return {
    opencodeSessionId,
    mmSession,
    streamCtx,
    threadRootPostId,
    responseBuffer: "",
    thinkingBuffer: "",
    toolCalls: [],
    activeTool: null,
    shellOutput: "",
    shellOutputLastUpdate: 0,
    lastUpdateTime: Date.now(),
    compactionCount: 0,
    todos: [],
    cost: {
      sessionTotal: sessionTotalCost,
      currentMessage: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    responseStartTime: Date.now(),
    awaitingContinuation: false,
    inCompactionSummary: false,
  };
}
