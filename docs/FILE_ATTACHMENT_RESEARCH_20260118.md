# File Attachment Research for OpenCode Mattermost Plugin

**Date:** 2026-01-18  
**Purpose:** Research bidirectional file attachment support between Mattermost and OpenCode

## Executive Summary

**Feasibility: FULLY IMPLEMENTABLE**

Both inbound (Mattermost → OpenCode) and outbound (OpenCode → Mattermost) file attachments are technically feasible with the existing OpenCode SDK. The current plugin has basic plumbing but needs updates to properly use the SDK types.

---

## Current State Analysis

### Plugin Implementation (`src/file-handler.ts`)

The plugin already has file handling infrastructure:

```typescript
// Inbound: Downloads files from Mattermost
async processInboundAttachments(fileIds: string[]): Promise<string[]>

// Outbound: Uploads files to Mattermost
async sendOutboundFile(session: UserSession, filePath: string, message?: string): Promise<void>
```

**Inbound Issue (Line 870-875 in index.ts):**
```typescript
if (route.fileIds && route.fileIds.length > 0) {
  const filePaths = await fileHandler.processInboundAttachments(route.fileIds);
  if (filePaths.length > 0) {
    promptText += `\n\n[Attached files: ${filePaths.join(", ")}]`;  // WRONG!
  }
}
```

Files are downloaded but only the **path string** is appended to the prompt text. This doesn't use the proper `FilePartInput` type.

**Outbound Issue (Line 1448-1462 in index.ts):**
```typescript
if (event.type === "file.edited" && fileHandler) {
  // Only triggers on file.edited events - misses new files!
}
```

Only handles `file.edited` events, not newly created files or tool-generated attachments.

---

## OpenCode SDK Findings

### 1. FilePartInput for Inbound Files

**Location:** `/tmp/opencode/packages/sdk/js/src/v2/gen/types.gen.ts:1813-1820`

```typescript
export type FilePartInput = {
  id?: string
  type: "file"
  mime: string
  filename?: string
  url: string          // Can be data: URL or file: URL
  source?: FilePartSource
}
```

**Usage in promptAsync:**
```typescript
await client.session.promptAsync({
  path: { id: sessionId },
  body: {
    parts: [
      { type: "text", text: promptMessage },
      { 
        type: "file", 
        mime: "application/pdf", 
        filename: "document.pdf",
        url: "data:application/pdf;base64,..." 
      }
    ]
  }
});
```

### 2. ToolStateCompleted Attachments

**Location:** `/tmp/opencode/packages/sdk/js/src/v2/gen/types.gen.ts:297-313`

```typescript
export type ToolStateCompleted = {
  status: "completed"
  input: { [key: string]: unknown }
  output: string
  title: string
  metadata: { [key: string]: unknown }
  time: { start: number; end: number; compacted?: number }
  attachments?: Array<FilePart>  // <-- KEY FIELD!
}
```

Tools can return file attachments in their execution result!

### 3. Existing Tool with Attachments: Read Tool

**Location:** `/tmp/opencode/packages/opencode/src/tool/read.ts:74-84`

```typescript
// When reading images or PDFs, the Read tool returns attachments:
if (isImage || isPdf) {
  return {
    title,
    output: "Image/PDF read successfully",
    metadata: { preview: msg, truncated: false },
    attachments: [
      {
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file",
        mime: file.type,
        url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
      },
    ],
  }
}
```

### 4. Available Events

**`message.part.updated` Event:**
```typescript
export type EventMessagePartUpdated = {
  type: "message.part.updated"
  properties: {
    part: Part  // Can be ToolPart with state.attachments!
    delta?: string
  }
}
```

When a tool completes, the `part.state.attachments` array contains generated files.

**`file.edited` Event:**
```typescript
export type EventFileEdited = {
  type: "file.edited"
  properties: {
    path: string
    // ... other properties
  }
}
```

Fires when existing files are modified (e.g., by Write tool).

---

## Implementation Plan

### Phase 1: Fix Inbound File Handling

**Current:** Appends file path as text  
**Target:** Send proper `FilePartInput` with base64-encoded content

```typescript
// In index.ts, modify the file handling block:
if (route.fileIds && route.fileIds.length > 0) {
  const filePaths = await fileHandler.processInboundAttachments(route.fileIds);
  const fileParts: FilePartInput[] = [];
  
  for (const filePath of filePaths) {
    const content = fs.readFileSync(filePath);
    const mime = fileHandler.getMimeType(filePath);
    const filename = path.basename(filePath);
    
    fileParts.push({
      type: "file",
      mime,
      filename,
      url: `data:${mime};base64,${content.toString("base64")}`,
    });
  }
  
  // Send with mixed parts
  await client.session.promptAsync({
    path: { id: targetSessionId },
    body: {
      parts: [
        { type: "text", text: promptMessage },
        ...fileParts,
      ],
      ...(selectedModel && { model: selectedModel }),
    },
  });
}
```

**Required Changes:**
1. Export `getMimeType` as public method in `FileHandler`
2. Modify `promptAsync` call to accept multiple parts
3. Handle size limits (consider chunking for large files)

### Phase 2: Fix Outbound File Handling

**Current:** Only handles `file.edited` events  
**Target:** Also capture tool attachments from `message.part.updated`

```typescript
// In the event handler:
if (event.type === "message.part.updated") {
  const part = event.properties.part;
  
  // Check if it's a completed tool with attachments
  if (part.type === "tool" && part.state.status === "completed") {
    const attachments = (part.state as ToolStateCompleted).attachments;
    
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        await sendAttachmentToMattermost(ctx, attachment);
      }
    }
  }
}

async function sendAttachmentToMattermost(ctx: ResponseContext, attachment: FilePart) {
  // Extract base64 from data URL
  const matches = attachment.url.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return;
  
  const [, mime, base64Data] = matches;
  const buffer = Buffer.from(base64Data, "base64");
  const filename = attachment.filename || `attachment-${Date.now()}.${getExtension(mime)}`;
  
  // Save to temp file and send
  const tempPath = path.join(config.tempDir, filename);
  fs.writeFileSync(tempPath, buffer);
  await fileHandler.sendOutboundFile(ctx.mmSession, tempPath, `Generated: ${filename}`);
}
```

### Phase 3: Custom PDF Generation Tool (Optional)

If users need OpenCode to generate PDFs specifically, create a custom tool:

```typescript
// tools/generate-pdf.ts
export const GeneratePdfTool = Tool.define<{
  content: string;
  filename: string;
  format?: "markdown" | "text";
}>("generate_pdf", {
  description: "Generate a PDF document from content",
  parameters: z.object({
    content: z.string().describe("Content to convert to PDF"),
    filename: z.string().describe("Output filename"),
    format: z.enum(["markdown", "text"]).optional().default("markdown"),
  }),
  async execute(args, ctx) {
    const pdf = await generatePdf(args.content, args.format);
    
    return {
      title: `Generated ${args.filename}`,
      output: `PDF created: ${args.filename}`,
      metadata: { size: pdf.length },
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file",
          mime: "application/pdf",
          filename: args.filename,
          url: `data:application/pdf;base64,${pdf.toString("base64")}`,
        },
      ],
    };
  },
});
```

---

## Model Support for Files

From the SDK types (`types.gen.ts:1056-1057`):
```typescript
modalities: {
  input: Array<"audio" | "image" | "pdf">
  output: Array<"audio" | "image" | "pdf">
}
```

**Supported Input Types:**
- Images (png, jpg, gif, webp) - most models
- PDFs - Claude, GPT-4o
- Audio - some models

**Model Considerations:**
- Check `model.modalities.input` before sending files
- Fall back to text extraction for unsupported models

---

## File Size Considerations

| Item | Limit | Notes |
|------|-------|-------|
| Plugin config | 10MB | `OPENCODE_MM_MAX_FILE_SIZE` |
| Mattermost | 50MB | Server configurable |
| Base64 overhead | 33% | 10MB file = ~13.3MB encoded |
| LLM context | Varies | Claude: ~100K tokens for images |

**Recommendations:**
1. Keep current 10MB limit for direct embedding
2. For larger files, use file:// URLs or extract text/summary
3. Warn user if file exceeds limits

---

## Summary of Required Changes

### Minimal Changes (Phase 1 + 2)

| File | Change | Effort |
|------|--------|--------|
| `src/file-handler.ts` | Export `getMimeType` | Small |
| `index.ts:870-875` | Use `FilePartInput` properly | Medium |
| `index.ts:1448-1462` | Add `message.part.updated` handler | Medium |
| `index.ts` | Add `sendAttachmentToMattermost` helper | Small |

**Estimated Effort:** 2-4 hours

### Full Implementation (Phase 1-3)

| Feature | Effort |
|---------|--------|
| Fix inbound files | 2 hours |
| Fix outbound files | 2 hours |
| Custom PDF tool | 4 hours |
| Testing | 2 hours |
| Documentation | 1 hour |

**Estimated Effort:** 1-2 days

---

## Testing Plan

### Inbound Tests
1. Upload PNG/JPG to Mattermost thread → Verify Claude sees the image
2. Upload PDF to thread → Verify content is accessible
3. Upload multiple files in one message
4. Upload unsupported file type → Verify graceful fallback

### Outbound Tests
1. Ask OpenCode to read an image file → Verify attachment sent to MM
2. Ask OpenCode to read a PDF → Verify attachment sent to MM
3. Use Write tool to create file → Verify `file.edited` still works
4. Generate PDF via custom tool (if implemented)

---

## References

- OpenCode SDK Types: `/tmp/opencode/packages/sdk/js/src/v2/gen/types.gen.ts`
- Read Tool Implementation: `/tmp/opencode/packages/opencode/src/tool/read.ts`
- Plugin Hooks: `/tmp/opencode/packages/plugin/src/index.ts`
- Current Plugin: `/root/gitrepos/opencode-mattermost-plugin/`
