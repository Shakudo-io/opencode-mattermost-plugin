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
 * Represents a captured edit diff from the edit tool
 */
export interface EditDiff {
  filePath: string;
  diff: string;
}

/**
 * Tracks a delegated subagent session and its Mattermost reply message
 */
export interface SubagentInfo {
  childSessionId: string;
  parentSessionId: string;
  threadRootPostId: string;
  replyPostId: string;
  agentType: string;
  description: string;
  status: string;
  startTime: number;
  toolCount: number;
  modelId?: string;
  agentHeader: string;
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
  /** Command being executed by bash tool (for display) */
  bashCommand?: string;
  /** Captured diffs from edit tool executions */
  editDiffs: EditDiff[];
  /** Last completed bash output (preserved after tool finishes for final display) */
  lastBashOutput?: string;
  /** Last completed bash command (preserved after tool finishes for final display) */
  lastBashCommand?: string;
  /** All completed bash outputs (command + output pairs) for multi-command display */
  completedBashOutputs: Array<{ command: string; output: string }>;
  /** Name of the active agent (e.g. "Build", "Plan") */
  agentName?: string;
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
    bashCommand: undefined,
    editDiffs: [],
    lastBashOutput: undefined,
    lastBashCommand: undefined,
    completedBashOutputs: [],
    agentName: undefined,
  };
}
