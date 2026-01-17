import { z } from "zod";
import { log } from "./logger";

export const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.string(),
  priority: z.string(),
});

export type TodoItem = z.infer<typeof TodoItemSchema>;

export interface TodoPostInfo {
  postId: string;
  lastUpdated: number;
  todos: TodoItem[];
}

const STATUS_ICONS: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⏳",
  cancelled: "❌",
};

const PRIORITY_MARKERS: Record<string, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🟢",
};

export class TodoManager {
  private todoPostsBySession: Map<string, TodoPostInfo> = new Map();
  private mmClient: any;
  private threadRootsBySession: Map<string, string> = new Map();

  constructor(mmClient: any) {
    this.mmClient = mmClient;
  }

  setThreadRoot(sessionId: string, threadRootPostId: string) {
    this.threadRootsBySession.set(sessionId, threadRootPostId);
  }

  formatTodoList(todos: TodoItem[]): string {
    if (!todos || todos.length === 0) {
      return "📋 **Task List**\n\n_No tasks yet_";
    }

    const completed = todos.filter((t) => t.status === "completed").length;
    const total = todos.length;

    let output = `📋 **Task List** (${completed}/${total} complete)\n\n`;

    const sortedTodos = [...todos].sort((a, b) => {
      const statusOrder: Record<string, number> = {
        in_progress: 0,
        pending: 1,
        completed: 2,
        cancelled: 3,
      };
      const priorityOrder: Record<string, number> = {
        high: 0,
        medium: 1,
        low: 2,
      };

      const statusDiff =
        (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
      if (statusDiff !== 0) return statusDiff;

      return (
        (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99)
      );
    });

    for (const todo of sortedTodos) {
      const statusIcon = STATUS_ICONS[todo.status] || "❓";
      const priorityMarker =
        todo.priority === "high" ? ` ${PRIORITY_MARKERS.high}` : "";

      if (todo.status === "completed") {
        output += `${statusIcon} ~~${todo.content}~~${priorityMarker}\n`;
      } else if (todo.status === "cancelled") {
        output += `${statusIcon} ~~${todo.content}~~ _(cancelled)_\n`;
      } else {
        output += `${statusIcon} ${todo.content}${priorityMarker}\n`;
      }
    }

    return output.trim();
  }

  async updateTodoPost(
    sessionId: string,
    todos: TodoItem[],
    channelId: string
  ): Promise<void> {
    const threadRootPostId = this.threadRootsBySession.get(sessionId);
    if (!threadRootPostId) {
      log.debug(
        `[TodoManager] No thread root for session ${sessionId.substring(0, 8)}`
      );
      return;
    }

    const formattedContent = this.formatTodoList(todos);
    const existingPost = this.todoPostsBySession.get(sessionId);

    try {
      if (existingPost) {
        await this.mmClient.updatePost(existingPost.postId, formattedContent);
        existingPost.lastUpdated = Date.now();
        existingPost.todos = todos;
        log.debug(
          `[TodoManager] Updated todo post for session ${sessionId.substring(0, 8)}`
        );
      } else {
        const newPost = await this.mmClient.createPost(
          channelId,
          formattedContent,
          threadRootPostId
        );
        this.todoPostsBySession.set(sessionId, {
          postId: newPost.id,
          lastUpdated: Date.now(),
          todos,
        });
        log.info(
          `[TodoManager] Created todo post for session ${sessionId.substring(0, 8)}`
        );
      }
    } catch (e) {
      log.error(`[TodoManager] Failed to update todo post:`, e);
    }
  }

  getTodoPost(sessionId: string): TodoPostInfo | undefined {
    return this.todoPostsBySession.get(sessionId);
  }

  clearSession(sessionId: string) {
    this.todoPostsBySession.delete(sessionId);
    this.threadRootsBySession.delete(sessionId);
  }
}
