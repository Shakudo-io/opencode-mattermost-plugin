import type { ResponseContext, TodoItem, ActiveTool, CostInfo, EditDiff } from "./types.js";

export const RESPONSE_UPDATE_INTERVAL_MS = 1000;
export const MAX_SHELL_OUTPUT_LINES = 15;
export const BASH_HEARTBEAT_THRESHOLD_MS = 10_000;
export const THINKING_LINE_LIMIT = 500;

const TODO_STATUS_ICONS: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⏳",
  cancelled: "❌",
};

export function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return `${tokens}`;
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

export function formatCostStatus(cost: CostInfo): string {
  const totalTokens = cost.tokens.input + cost.tokens.output + cost.tokens.reasoning;
  if (cost.sessionTotal === 0 && cost.currentMessage === 0 && totalTokens === 0) return "";
  
  const sessionCost = formatCost(cost.sessionTotal + cost.currentMessage);
  const msgCost = cost.currentMessage > 0 ? ` (+${formatCost(cost.currentMessage)})` : "";
  const tokenStr = totalTokens > 0 ? ` | ${formatTokenCount(totalTokens)} tok` : "";
  
  return `💰 ${sessionCost}${msgCost}${tokenStr}`;
}

export function formatToolStatus(
  toolCalls: string[],
  activeTool: ActiveTool | null,
  compactionCount: number = 0,
  cost?: CostInfo,
  responseStartTime?: number,
  awaitingContinuation?: boolean
): string {
  const parts: string[] = [];
  
  if (responseStartTime) {
    const elapsed = formatElapsedTime(Date.now() - responseStartTime);
    parts.push(`💻 Processing (${elapsed})`);
  }
  
  if (toolCalls.length > 0) {
    const toolCounts = toolCalls.reduce((acc, tool) => {
      acc[tool] = (acc[tool] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const summary = Object.entries(toolCounts)
      .map(([tool, count]) => count > 1 ? `\`${tool}\` ×${count}` : `\`${tool}\``)
      .join(", ");
    parts.push(`✅ ${summary}`);
  }
  
  if (compactionCount > 0) {
    parts.push(compactionCount > 1 ? `📦 Compacted ×${compactionCount}` : `📦 Compacted`);
  }
  
  if (awaitingContinuation) {
    parts.push(`⏳ Continuing...`);
  }
  
  if (cost && (cost.sessionTotal > 0 || cost.currentMessage > 0 || cost.tokens.input > 0)) {
    parts.push(formatCostStatus(cost));
  }
  
  if (activeTool) {
    const elapsed = formatElapsedTime(Date.now() - activeTool.startTime);
    parts.push(`🔧 \`${activeTool.name}\` (${elapsed})...`);
  }
  
  return parts.join(" | ");
}

export function formatShellOutput(
  shellOutput: string,
  bashCommand?: string,
  lastOutputTime?: number,
  toolStartTime?: number
): string {
  if (!shellOutput && !bashCommand) return "";
  
  // Start with the command echo if available
  let output = "";
  if (bashCommand) {
    output = `$ ${bashCommand}\n`;
  }
  
  // Handle empty shell output (command just started)
  if (!shellOutput || !shellOutput.trim()) {
    return output.trim();
  }
  
  const lines = shellOutput.trim().split('\n');
  const totalLines = lines.length;
  
  if (totalLines <= MAX_SHELL_OUTPUT_LINES) {
    output += shellOutput.trim();
  } else {
    const tailLines = lines.slice(-MAX_SHELL_OUTPUT_LINES);
    output += `... (${totalLines - MAX_SHELL_OUTPUT_LINES} lines hidden)\n${tailLines.join('\n')}`;
  }
  
  if (lastOutputTime && toolStartTime) {
    const timeSinceLastOutput = Date.now() - lastOutputTime;
    const totalRunTime = Date.now() - toolStartTime;
    
    if (timeSinceLastOutput >= BASH_HEARTBEAT_THRESHOLD_MS) {
      const lastOutputAgo = formatElapsedTime(timeSinceLastOutput);
      const runningFor = formatElapsedTime(totalRunTime);
      output += `\n\n⏳ Still running (${runningFor} total, last output ${lastOutputAgo} ago)`;
    }
  }
  
  return output;
}

export function formatEditDiffs(diffs: EditDiff[]): string {
  if (!diffs || diffs.length === 0) return "";
  
  let output = "";
  for (const edit of diffs) {
    output += `📝 **${edit.filePath}**\n`;
    output += "```diff\n" + edit.diff + "\n```\n\n";
  }
  return output;
}

export function formatTodoStatus(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return "";
  
  const completed = todos.filter(t => t.status === "completed").length;
  const total = todos.length;
  
  const sortedTodos = [...todos].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
      cancelled: 3,
    };
    return (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
  });
  
  let output = `📋 **Tasks** (${completed}/${total})\n`;
  
  for (const todo of sortedTodos) {
    const icon = TODO_STATUS_ICONS[todo.status] || "❓";
    if (todo.status === "completed" || todo.status === "cancelled") {
      output += `${icon} ~~${todo.content}~~\n`;
    } else {
      output += `${icon} ${todo.content}\n`;
    }
  }
  
  return output;
}

export function formatFullResponse(ctx: ResponseContext): string {
  const toolStatus = formatToolStatus(
    ctx.toolCalls,
    ctx.activeTool,
    ctx.compactionCount,
    ctx.cost,
    ctx.responseStartTime,
    ctx.awaitingContinuation
  );
  const todoStatus = formatTodoStatus(ctx.todos);
  const thinkingPreview = ctx.thinkingBuffer.length > THINKING_LINE_LIMIT 
    ? ctx.thinkingBuffer.slice(-THINKING_LINE_LIMIT) + "..." 
    : ctx.thinkingBuffer;
  
  let output = "";
  
  if (toolStatus) {
    output += toolStatus + "\n\n";
  }
  
  if (todoStatus) {
    output += todoStatus + "\n";
  }
  
  if ((ctx.shellOutput || ctx.bashCommand) && ctx.activeTool?.name === "bash") {
    const formattedShell = formatShellOutput(
      ctx.shellOutput,
      ctx.bashCommand,
      ctx.shellOutputLastUpdate,
      ctx.activeTool.startTime
    );
    output += "```bash\n" + formattedShell + "\n```\n\n";
  }
  
  if (ctx.editDiffs && ctx.editDiffs.length > 0) {
    output += formatEditDiffs(ctx.editDiffs);
  }
  
  if (ctx.responseBuffer) {
    const needsSeparator = toolStatus || todoStatus || ctx.shellOutput;
    if (needsSeparator) {
      output += "---\n\n";
    }
    output += ctx.responseBuffer;
  }
  
  if (ctx.thinkingBuffer) {
    output += `\n\n---\n:brain: **Thinking:**\n> ${thinkingPreview.split('\n').join('\n> ')}`;
  }
  
  return output;
}
