import { describe, test, expect, beforeEach } from "bun:test";
import { CommandHandler } from "../../src/command-handler.js";
import type { ParsedCommand } from "../../src/message-router.js";
import type { CommandContext } from "../../src/command-handler.js";

function createMockRegistry() {
  return {
    refresh: async () => {},
    listAvailable: () => [],
    get: (_id: string) => null,
    getDefault: () => null,
  };
}

function createMockMmClient() {
  return {
    getUserByUsername: async (_username: string) => ({ id: "user-123" }),
  };
}

function createMockContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    userSession: {
      mattermostUserId: "user-123",
      mattermostUsername: "testuser",
      dmChannelId: "dm-channel-123",
      targetOpenCodeSessionId: null,
      lastActivity: new Date(),
      pendingPermissions: [],
    },
    registry: createMockRegistry() as any,
    mmClient: createMockMmClient() as any,
    ...overrides,
  };
}

describe("CommandHandler", () => {
  let handler: CommandHandler;

  beforeEach(() => {
    handler = new CommandHandler("!");
  });

  describe("isKnownCommand", () => {
    test("returns true for registered commands", () => {
      expect(handler.isKnownCommand("sessions")).toBe(true);
      expect(handler.isKnownCommand("use")).toBe(true);
      expect(handler.isKnownCommand("current")).toBe(true);
      expect(handler.isKnownCommand("help")).toBe(true);
      expect(handler.isKnownCommand("models")).toBe(true);
      expect(handler.isKnownCommand("model")).toBe(true);
      expect(handler.isKnownCommand("costs")).toBe(true);
      expect(handler.isKnownCommand("stop")).toBe(true);
      expect(handler.isKnownCommand("merge")).toBe(true);
      expect(handler.isKnownCommand("team")).toBe(true);
      expect(handler.isKnownCommand("reject")).toBe(true);
      expect(handler.isKnownCommand("cancel")).toBe(true);
      expect(handler.isKnownCommand("migrate")).toBe(true);
      expect(handler.isKnownCommand("export")).toBe(true);
    });

    test("returns false for unknown commands", () => {
      expect(handler.isKnownCommand("unknown")).toBe(false);
      expect(handler.isKnownCommand("foo")).toBe(false);
      expect(handler.isKnownCommand("")).toBe(false);
    });
  });

  describe("getAvailableCommands", () => {
    test("returns array of command names", () => {
      const commands = handler.getAvailableCommands();
      
      expect(Array.isArray(commands)).toBe(true);
      expect(commands).toContain("sessions");
      expect(commands).toContain("help");
      expect(commands).toContain("use");
    });
  });

  describe("execute", () => {
    test("returns error for unknown command", async () => {
      const command: ParsedCommand = {
        name: "unknown",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unknown command");
      expect(result.message).toContain("!unknown");
      expect(result.message).toContain("!help");
    });

    test("handles sessions command with no sessions", async () => {
      const command: ParsedCommand = {
        name: "sessions",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(true);
      expect(result.message).toContain("No active OpenCode sessions");
    });

    test("handles use command without argument", async () => {
      const command: ParsedCommand = {
        name: "use",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage");
      expect(result.message).toContain("!use <session-id>");
    });

    test("handles use command with non-existent session", async () => {
      const command: ParsedCommand = {
        name: "use",
        args: ["ses_nonexistent"],
        rawArgs: "ses_nonexistent",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Session not found");
    });

    test("handles current command with no selection", async () => {
      const command: ParsedCommand = {
        name: "current",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(true);
      expect(result.message).toContain("No");
    });

    test("handles help command", async () => {
      const command: ParsedCommand = {
        name: "help",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Available Commands");
      expect(result.message).toContain("sessions");
      expect(result.message).toContain("help");
    });

    test("handles models command without session context", async () => {
      const command: ParsedCommand = {
        name: "models",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
    });

    test("handles stop command without session context", async () => {
      const command: ParsedCommand = {
        name: "stop",
        args: [],
        rawArgs: "",
      };
      // Provide opencodeClient but no sessionId to test the "no session" case
      const context = createMockContext({
        opencodeClient: {} as any,
        sessionId: undefined,
      });

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("inside a session thread");
    });

    test("handles merge command without URL", async () => {
      const command: ParsedCommand = {
        name: "merge",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext({
        sessionId: "ses_abc123",
        threadRootPostId: "thread-123",
        channelId: "channel-456",
        opencodeClient: {},
        threadMappingStore: {} as any,
      });

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage");
      expect(result.message).toContain("merge <thread-url>");
    });

    test("handles team command without owner permission", async () => {
      const command: ParsedCommand = {
        name: "team",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext({
        teamStore: {} as any,
        ownerUserId: "different-owner",
      });

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Only the owner");
    });

    test("handles reject command without session context", async () => {
      const command: ParsedCommand = {
        name: "reject",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("inside a session thread");
    });

    test("handles migrate command without owner permission", async () => {
      const command: ParsedCommand = {
        name: "migrate",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext({
        ownerUserId: "different-owner",
      });

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Only the owner");
    });

    test("handles export command without owner permission", async () => {
      const command: ParsedCommand = {
        name: "export",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext({
        ownerUserId: "different-owner",
      });

      const result = await handler.execute(command, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Only the owner");
    });
  });

  describe("custom prefix", () => {
    test("uses custom prefix in error messages", async () => {
      const customHandler = new CommandHandler("/");
      const command: ParsedCommand = {
        name: "unknown",
        args: [],
        rawArgs: "",
      };
      const context = createMockContext();

      const result = await customHandler.execute(command, context);

      expect(result.message).toContain("/unknown");
      expect(result.message).toContain("/help");
    });
  });

  describe("isPendingModelSelection", () => {
    test("returns false without threadMappingStore", () => {
      expect(handler.isPendingModelSelection("ses_123", null)).toBe(false);
    });

    test("returns false when no mapping exists", () => {
      const mockStore = {
        getBySessionId: () => null,
      };
      expect(handler.isPendingModelSelection("ses_123", mockStore as any)).toBe(false);
    });

    test("returns false when pendingModelSelection is false", () => {
      const mockStore = {
        getBySessionId: () => ({ pendingModelSelection: false }),
      };
      expect(handler.isPendingModelSelection("ses_123", mockStore as any)).toBe(false);
    });

    test("returns true when pendingModelSelection is true", () => {
      const mockStore = {
        getBySessionId: () => ({ pendingModelSelection: true }),
      };
      expect(handler.isPendingModelSelection("ses_123", mockStore as any)).toBe(true);
    });
  });
});
