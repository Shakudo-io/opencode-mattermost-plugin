import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { PluginState } from "../state.js";

export function createSendFileTool(): ToolDefinition {
  return tool({
    description: "Upload a file to the current Mattermost conversation thread. Use this when the user asks you to send them a file you've created or modified.",
    args: {
      filePath: tool.schema.string().describe("Absolute path to the file to send"),
      message: tool.schema.string().optional().describe("Optional message to accompany the file"),
    },
    async execute(args, ctx) {
      const { isConnected, fileHandler, threadMappingStore, mmClient } = PluginState;
      
      if (!isConnected || !fileHandler || !threadMappingStore || !mmClient) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      const mapping = threadMappingStore.getBySessionId(ctx.sessionID);
      if (!mapping) {
        return `No Mattermost thread associated with session ${ctx.sessionID.substring(0, 8)}. This tool can only be used when responding to a Mattermost conversation.`;
      }

      if (mapping.status === "ended" || mapping.status === "disconnected") {
        return `The Mattermost thread for session ${ctx.sessionID.substring(0, 8)} is no longer active (status: ${mapping.status}).`;
      }

      const result = await fileHandler.sendFileToThread(
        mapping.channelId || mapping.dmChannelId,
        mapping.threadRootPostId,
        args.filePath,
        args.message
      );

      if (result.success) {
        return `File sent to Mattermost: ${result.fileName}`;
      } else {
        return `Failed to send file: ${result.error}`;
      }
    },
  });
}
