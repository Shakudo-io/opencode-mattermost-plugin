import { describe, test, expect, beforeEach } from "bun:test";
import { MessageRouter } from "../../src/message-router.js";
import type { ThreadSessionMapping } from "../../src/models/index.js";
import { createMockPost, createMockThreadSessionMapping } from "../__mocks__/index.js";

describe("MessageRouter", () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter("!");
  });

  describe("route (basic routing)", () => {
    test("identifies command messages", () => {
      const post = createMockPost({ message: "!sessions" });
      const result = router.route(post);
      
      expect(result.type).toBe("command");
      expect(result.command?.name).toBe("sessions");
    });

    test("identifies prompt messages", () => {
      const post = createMockPost({ message: "Hello, help me with code" });
      const result = router.route(post);
      
      expect(result.type).toBe("prompt");
      expect(result.promptText).toBe("Hello, help me with code");
    });

    test("trims whitespace from messages", () => {
      const post = createMockPost({ message: "  !help  " });
      const result = router.route(post);
      
      expect(result.type).toBe("command");
      expect(result.command?.name).toBe("help");
    });
  });

  describe("parseCommand", () => {
    test("parses command name", () => {
      const result = router.parseCommand("!sessions");
      
      expect(result?.name).toBe("sessions");
      expect(result?.args).toEqual([]);
      expect(result?.rawArgs).toBe("");
    });

    test("parses command with arguments", () => {
      const result = router.parseCommand("!use ses_abc123");
      
      expect(result?.name).toBe("use");
      expect(result?.args).toEqual(["ses_abc123"]);
      expect(result?.rawArgs).toBe("ses_abc123");
    });

    test("parses command with multiple arguments", () => {
      const result = router.parseCommand("!merge https://example.com/post/123 --force");
      
      expect(result?.name).toBe("merge");
      expect(result?.args).toEqual(["https://example.com/post/123", "--force"]);
      expect(result?.rawArgs).toBe("https://example.com/post/123 --force");
    });

    test("converts command name to lowercase", () => {
      const result = router.parseCommand("!SESSIONS");
      
      expect(result?.name).toBe("sessions");
    });

    test("returns null for non-command messages", () => {
      const result = router.parseCommand("Hello world");
      
      expect(result).toBeNull();
    });

    test("handles empty command after prefix", () => {
      const result = router.parseCommand("!");
      
      expect(result?.name).toBe("");
      expect(result?.args).toEqual([]);
    });
  });

  describe("routeWithThreads", () => {
    let threadMappings: Map<string, ThreadSessionMapping>;

    beforeEach(() => {
      threadMappings = new Map();
      router.setThreadLookup((threadRootPostId) => {
        const mapping = threadMappings.get(threadRootPostId);
        return mapping || null;
      });
    });

    test("routes thread prompt to active session", () => {
      const mapping = createMockThreadSessionMapping({
        threadRootPostId: "thread-123",
        sessionId: "ses_abc",
        status: "active",
      });
      threadMappings.set("thread-123", mapping);

      const post = createMockPost({
        message: "Help me with this code",
        root_id: "thread-123",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("thread_prompt");
      if (result.type === "thread_prompt") {
        expect(result.sessionId).toBe("ses_abc");
        expect(result.promptText).toBe("Help me with this code");
      }
    });

    test("returns ended_session for ended sessions", () => {
      const mapping = createMockThreadSessionMapping({
        threadRootPostId: "thread-123",
        sessionId: "ses_abc",
        status: "ended",
      });
      threadMappings.set("thread-123", mapping);

      const post = createMockPost({
        message: "Help me",
        root_id: "thread-123",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("ended_session");
      if (result.type === "ended_session") {
        expect(result.sessionId).toBe("ses_abc");
        expect(result.errorMessage).toContain("session has ended");
      }
    });

    test("returns ended_session for disconnected sessions", () => {
      const mapping = createMockThreadSessionMapping({
        threadRootPostId: "thread-123",
        sessionId: "ses_abc",
        status: "disconnected",
      });
      threadMappings.set("thread-123", mapping);

      const post = createMockPost({
        message: "Help me",
        root_id: "thread-123",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("ended_session");
      if (result.type === "ended_session") {
        expect(result.errorMessage).toContain("disconnected");
      }
    });

    test("returns merged_session for merged sessions", () => {
      const mapping = createMockThreadSessionMapping({
        threadRootPostId: "thread-123",
        sessionId: "ses_abc",
        status: "merged",
        mergedInto: "thread-456",
      });
      threadMappings.set("thread-123", mapping);

      const post = createMockPost({
        message: "Help me",
        root_id: "thread-123",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("merged_session");
      if (result.type === "merged_session") {
        expect(result.mergedInto).toBe("thread-456");
      }
    });

    test("returns ended_session for orphaned sessions", () => {
      const mapping = createMockThreadSessionMapping({
        threadRootPostId: "thread-123",
        sessionId: "ses_abc",
        status: "orphaned",
      });
      threadMappings.set("thread-123", mapping);

      const post = createMockPost({
        message: "Help me",
        root_id: "thread-123",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("ended_session");
      if (result.type === "ended_session") {
        expect(result.errorMessage).toContain("no longer available");
      }
    });

    test("returns unknown_thread for unmapped threads", () => {
      const post = createMockPost({
        message: "Help me",
        root_id: "unknown-thread",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("unknown_thread");
      if (result.type === "unknown_thread") {
        expect(result.errorMessage).toContain("not associated");
      }
    });

    test("routes main DM commands", () => {
      const post = createMockPost({
        message: "!sessions",
        root_id: "",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("main_dm_command");
      if (result.type === "main_dm_command") {
        expect(result.command.name).toBe("sessions");
      }
    });

    test("rejects main DM prompts with suggestion", () => {
      const post = createMockPost({
        message: "Help me with code",
        root_id: "",
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("main_dm_prompt");
      if (result.type === "main_dm_prompt") {
        expect(result.errorMessage).toContain("session thread");
        expect(result.suggestedAction).toContain("!sessions");
      }
    });

    test("includes file_ids in thread prompt route", () => {
      const mapping = createMockThreadSessionMapping({
        threadRootPostId: "thread-123",
        sessionId: "ses_abc",
        status: "active",
      });
      threadMappings.set("thread-123", mapping);

      const post = createMockPost({
        message: "Check this file",
        root_id: "thread-123",
        file_ids: ["file-1", "file-2"],
      });

      const result = router.routeWithThreads(post);

      expect(result.type).toBe("thread_prompt");
      if (result.type === "thread_prompt") {
        expect(result.fileIds).toEqual(["file-1", "file-2"]);
      }
    });
  });

  describe("custom command prefix", () => {
    test("uses custom prefix", () => {
      const customRouter = new MessageRouter("/");
      const post = createMockPost({ message: "/sessions" });
      const result = customRouter.route(post);

      expect(result.type).toBe("command");
      expect(result.command?.name).toBe("sessions");
    });

    test("getCommandPrefix returns current prefix", () => {
      const customRouter = new MessageRouter("/");
      expect(customRouter.getCommandPrefix()).toBe("/");
    });
  });
});
