/**
 * OpenCode V2 adapter entry for the Shakudo "Mattermost Control" plugin.
 *
 * The upstream plugin (v0.3.97) is written against the V1 plugin API:
 *
 *   export const MattermostControlPlugin: Plugin = async ({ client, project, directory, serverUrl, $ }) =>
 *     ({ tool, event, "tool.execute.before", "tool.execute.after", "chat.message" })
 *
 * OpenCode v2.x refuses to load that shape ("Plugin must export a default
 * definition with an id and an effect or setup function"). This file is the
 * only adapter layer added by the port:
 *
 *   1. A V1-style `client.session` object implemented on top of the V2
 *      session domain (in-process, no network hop).
 *   2. A local V1-compatible HTTP server (127.0.0.1, ephemeral port)
 *      implementing the handful of legacy REST endpoints the plugin code
 *      still fetches directly (/question, /question/:id/reply, /find/file,
 *      /file/content), bridging to the V2 server via the `opencode api` CLI
 *      (which handles service discovery + authentication).
 *   3. A V2 -> V1 event translator feeding the plugin's `event` hook.
 *   4. Registration of the plugin's 15 tools, its tool.execute.before/after
 *      hooks, and its chat.message hook (V2 "prompt" session hook).
 *
 * The upstream entry itself lives in ./legacy.ts, unmodified. To re-merge a
 * new upstream release: copy its `.opencode/plugin/mattermost-control/`
 * (minus this index.ts) and `src/` files over this directory, keep this file,
 * run `npm install`, done.
 */

import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { execFile } from "node:child_process";

import { MattermostControlPlugin } from "./legacy.js";
import { PluginState } from "./state.js";

// ---------------------------------------------------------------------------
// `opencode api` CLI bridge (service discovery + challenge-response auth)
// ---------------------------------------------------------------------------

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

function log(msg: string, ...rest: unknown[]): void {
  try {
    console.log(`[mattermost-v2] ${msg}`, ...rest);
  } catch {}
}

async function apiCall(
  method: "get" | "post",
  path: string,
  opts: { data?: unknown; directory?: string } = {}
): Promise<Buffer> {
  let url = path;
  if (opts.directory && !url.includes("location[")) {
    url += (url.includes("?") ? "&" : "?") + `location[directory]=${encodeURIComponent(opts.directory)}`;
  }
  const args = ["api", method, url];
  if (opts.data !== undefined) args.push("--data", JSON.stringify(opts.data));
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      OPENCODE_BIN,
      args,
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        // execFile types vary by @types/node overload: accept Buffer or string.
        const out = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(stdout as unknown as string, "utf8");
        if (err) {
          reject(new Error(`${OPENCODE_BIN} api ${method} ${path} failed: ${err.message}${out.length ? `\n${out.toString("utf8").slice(0, 500)}` : ""}`));
        } else {
          resolve(out);
        }
      }
    );
  });
}

async function apiJson<T = unknown>(
  method: "get" | "post",
  path: string,
  opts: { data?: unknown; directory?: string } = {}
): Promise<T> {
  const raw = await apiCall(method, path, opts);
  const text = raw.toString("utf8").trim();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// V1-compatible HTTP server (question state + replies, file search + content)
// ---------------------------------------------------------------------------

/** V2 Form.Info -> V1 OpenCodeQuestion[] (the shape question-handler.ts expects). */
function formsToQuestions(forms: any[]): any[] {
  return (forms || []).map((f) => ({
    id: f.id,
    sessionID: f.sessionID,
    questions: (f.fields || []).map((field: any) => ({
      // V2 form fields (built by the V2 `question` tool): key=qN, title=short
      // header, description=full question text, options value === label.
      question: field.description || field.title || String(field.key ?? ""),
      header: field.title || String(field.key ?? ""),
      options: (field.options || []).map((o: any) => ({ label: o.label, description: o.description || "" })),
      multiple: field.type === "multiselect",
      custom: field.custom ?? true,
    })),
  }));
}

async function handleCompatRequest(req: Request, directory: string): Promise<Response> {
  const u = new URL(req.url, "http://compat.local");
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // GET /question -> pending V1 questions (V2: forms)
  if (req.method === "GET" && u.pathname === "/question") {
    const res = await apiJson<any>("get", "/api/form", { directory });
    return json(200, formsToQuestions(Array.isArray(res?.data) ? res.data : []));
  }

  // POST /question/{id}/reply { answers: string[][] }
  if (req.method === "POST" && u.pathname.startsWith("/question/") && u.pathname.endsWith("/reply")) {
    const formId = decodeURIComponent(u.pathname.slice("/question/".length, -"/reply".length));
    const body = await req.json().catch(() => ({}));
    const answers: any[] = Array.isArray((body as any)?.answers) ? (body as any).answers : [];
    const res = await apiJson<any>("get", "/api/form", { directory });
    const form = ((res?.data || []) as any[]).find((f) => f.id === formId);
    if (!form) return json(404, { error: `form ${formId} not found (no longer pending?)` });
    const answer: Record<string, unknown> = {};
    for (const [i, field] of ((form.fields || []) as any[]).entries()) {
      const vals = answers[i];
      if (field.type === "multiselect") {
        answer[field.key] = Array.isArray(vals) ? vals : [];
      } else {
        answer[field.key] = Array.isArray(vals) ? (vals[0] ?? "") : typeof vals === "string" ? vals : "";
      }
    }
    await apiCall("post", `/api/session/${form.sessionID}/form/${form.id}/reply`, {
      data: { answer },
      directory,
    });
    return json(200, {});
  }

  // GET /find/file?query=&limit= -> plain array of relative file paths
  if (req.method === "GET" && u.pathname === "/find/file") {
    const query = u.searchParams.get("query") ?? "";
    const limit = u.searchParams.get("limit");
    let p = `/api/fs/find?query=${encodeURIComponent(query)}&type=file`;
    if (limit) p += `&limit=${encodeURIComponent(limit)}`;
    const res = await apiJson<any>("get", p, { directory });
    const paths = ((res?.data || []) as any[]).filter((e) => e?.type === "file").map((e) => e.path);
    return json(200, paths);
  }

  // GET /file/content?path= -> { content: string }
  if (req.method === "GET" && u.pathname === "/file/content") {
    const path = u.searchParams.get("path") ?? "";
    const raw = await apiCall("get", `/api/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, {
      directory,
    });
    return json(200, { content: raw.toString("utf8") });
  }

  return json(404, { error: `no V1-compat route for ${req.method} ${u.pathname}` });
}

async function startCompatServer(directory: string): Promise<{ url: URL; close: () => Promise<void> }> {
  const B = (globalThis as any).Bun;
  if (B?.serve) {
    const server = B.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req: Request): Promise<Response> {
        try {
          return await handleCompatRequest(req, directory);
        } catch (e: any) {
          log("compat server error:", e?.message || e);
          return new Response(JSON.stringify({ error: String(e?.message || e) }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    });
    return {
      url: new URL(server.url),
      close: () =>
        new Promise<void>((r) => {
          try {
            server.stop(true);
          } catch {}
          r();
        }),
    };
  }

  // node:http fallback (works in Node-based hosts)
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers: Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v as string)])),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      } as RequestInit);
      const response = await handleCompatRequest(request, directory);
      const payload = await response.text();
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(payload);
    } catch (e: any) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------
// V1-style client.session shim (in-process, on top of the V2 session domain)
// ---------------------------------------------------------------------------

async function waitForCompletion(
  ctx: any,
  sessionID: string,
  statusMap: Map<string, any>,
  timeoutMs = 10 * 60 * 1000
): Promise<void> {
  const wait = (ctx.session as any)?.wait;
  if (typeof wait === "function") {
    try {
      await wait.call(ctx.session, { sessionID });
      return;
    } catch (e) {
      log("session.wait unavailable/failed, falling back to status polling:", (e as any)?.message || e);
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = statusMap.get(sessionID);
    if (!st || (st.type !== "busy" && st.type !== "retry")) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function buildClientShim(ctx: any, directory: string, statusMap: Map<string, any>) {
  const filesFromParts = (parts: any[]) =>
    (parts || [])
      .filter((p) => p?.type === "file")
      .map((p) => ({ uri: p.url, name: p.filename }));
  const textFromParts = (parts: any[]) =>
    (parts || []).filter((p) => p?.type === "text").map((p) => p?.text ?? "").join("");

  return {
    session: {
      // V1: client.session.list() -> { data: OpenCodeSession[] }
      // (OpenCodeSessionRegistry consumes .directory, .slug || id, .time.updated, skips .parentID)
      async list() {
        const res = await apiJson<any>("get", "/api/session", { directory });
        return {
          data: ((res?.data || []) as any[]).map((s) => ({
            id: s.id,
            projectID: s.projectID,
            directory: s.location?.directory ?? directory,
            parentID: s.parentID,
            title: s.title,
            time: s.time,
          })),
        };
      },

      // V1: client.session.status() -> { data: Record<sessionID, { type: "busy"|"retry", ... }> }
      async status() {
        const data: Record<string, any> = {};
        for (const [sid, st] of statusMap) data[sid] = st;
        try {
          const res = await apiJson<any>("get", "/api/session/active", { directory });
          for (const [sid, st] of Object.entries((res?.data || {}) as Record<string, any>)) {
            if (!data[sid]) data[sid] = { type: "busy" };
          }
        } catch (e) {
          log("session/active lookup failed:", (e as any)?.message || e);
        }
        return { data };
      },

      // V1: client.session.create({ body, query }) -> { data: { id, title } }
      async create(args: any) {
        const info: any = await ctx.session.create({
          location: { directory: args?.query?.directory ?? directory },
          ...(args?.body && typeof args.body === "object" ? args.body : {}),
        });
        return { data: { id: info.id, title: info.title } };
      },

      // V1: client.session.get({ path: { id } }) -> { data: Session }
      async get(args: any) {
        const info = await ctx.session.get({ sessionID: args?.path?.id });
        return { data: info };
      },

      // V1: client.session.messages({ path: { id } }) -> { data: Message[] }
      // (index.ts sums assistant message.info.cost)
      async messages(args: any) {
        const sessionID = args?.path?.id;
        const msgs = (await ctx.session.context({ sessionID })) as any[];
        return {
          data: (msgs || []).map((m) => ({
            info:
              m?.type === "assistant"
                ? {
                    id: m.id,
                    role: "assistant",
                    sessionID,
                    agent: m.agent,
                    modelID: m.model?.id,
                    cost: m.cost,
                    tokens: m.tokens,
                    time: m.time,
                  }
                : { id: m.id, role: m?.type === "user" ? "user" : "system", sessionID, time: m.time },
          })),
        };
      },

      // V1: client.session.promptAsync({ path: { id }, body: { parts, model? } })
      // (the main DM prompt injection path)
      async promptAsync(args: any) {
        const sessionID = args?.path?.id;
        const parts: any[] = args?.body?.parts ?? [];
        const model = args?.body?.model;
        if (model?.providerID && model?.modelID) {
          try {
            await ctx.session.switchModel({ sessionID, model: { id: model.modelID, providerID: model.providerID } });
          } catch (e) {
            log("switchModel failed:", (e as any)?.message || e);
          }
        }
        const files = filesFromParts(parts);
        await ctx.session.prompt({
          sessionID,
          text: textFromParts(parts),
          files: files.length ? files : undefined,
          delivery: "queue",
        });
        return { data: {} };
      },

      // V1: client.session.prompt(...) — two call shapes in the legacy code:
      //  (a) { path: { id }, body: { parts } }  — synchronous prompt (scheduler executor)
      //  (b) { sessionId, prompt, model }       — Haiku context summarization (context-builder)
      async prompt(args: any) {
        if (args && typeof args?.prompt === "string" && args.sessionId) {
          if (args.model?.providerID && args.model?.modelID) {
            try {
              const r: any = await ctx.experimental.generate.text({
                model: { providerID: args.model.providerID, id: args.model.modelID },
                prompt: args.prompt,
              });
              return { text: r?.text ?? "" };
            } catch (e) {
              log("experimental.generate.text failed:", (e as any)?.message || e);
            }
          }
          const r: any = await ctx.session.generate({ sessionID: args.sessionId, prompt: args.prompt });
          return { text: r?.text ?? "" };
        }
        const sessionID = args?.path?.id;
        const parts: any[] = args?.body?.parts ?? [];
        const files = filesFromParts(parts);
        await ctx.session.prompt({
          sessionID,
          text: textFromParts(parts),
          files: files.length ? files : undefined,
          delivery: "queue",
        });
        await waitForCompletion(ctx, sessionID, statusMap);
        const msgs = (await ctx.session.context({ sessionID })) as any[];
        const last = [...(msgs || [])].reverse().find((m) => m?.type === "assistant");
        const text = last
          ? ((last.content || []) as any[]).filter((c) => c?.type === "text").map((c) => c?.text ?? "").join("")
          : "";
        return { data: { text } };
      },

      // V1: client.session.abort({ path: { id } })
      async abort(args: any) {
        await ctx.session.interrupt({ sessionID: args?.path?.id, resume: false });
        return { data: true };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// V2 -> V1 event translator
// ---------------------------------------------------------------------------

/** V2 tool events carry no tool name; classify from the input shape. */
function classifyToolName(input: any): string {
  if (!input || typeof input !== "object") return "";
  if (input.command) return "bash";
  if (input.filePath || input.file_path) return "edit";
  if (Array.isArray(input.todos)) return "todo";
  if (Array.isArray(input.questions)) return "question";
  if (input.description && (input.agent || input.subagent_type)) return "task";
  return "";
}

function startEventBridge(ctx: any, legacyEvent: any, statusMap: Map<string, any>): () => void {
  const toolNames = new Map<string, string>(); // tool call id -> classified name
  const toolInputs = new Map<string, any>(); // tool call id -> input (for todo synthesis)
  const ac = new AbortController();

  const emit = (v1Type: string, properties: any) => {
    if (typeof legacyEvent !== "function") return;
    Promise.resolve(legacyEvent({ event: { type: v1Type, properties } })).catch((e) =>
      log(`legacy event handler failed for ${v1Type}:`, (e as any)?.message || e)
    );
  };

  // V1 file.edited needs a sessionID; V2 filesystem events have none.
  const singleResponseSession = (): string | null => {
    const contexts = PluginState.activeResponseContexts;
    if (contexts.size === 1) return contexts.values().next().value?.opencodeSessionId ?? null;
    return null;
  };

  (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
        const d = (ev as any)?.data ?? {};
        switch (ev.type) {
          case "permission.asked":
            emit("permission.asked", { sessionID: d.sessionID, description: d.message || "Permission requested" });
            break;

          case "form.created": {
            const form = d.form ?? {};
            emit("question.asked", {
              id: form.id,
              sessionID: form.sessionID,
              questions: (form.fields || []).map((f: any) => ({
                question: f.description || f.title || "",
                header: f.title || "",
                options: (f.options || []).map((o: any) => ({ label: o.label, description: o.description || "" })),
                multiple: f.type === "multiselect",
                custom: f.custom ?? true,
              })),
            });
            break;
          }

          case "session.idle":
            statusMap.delete(d.sessionID);
            emit("session.idle", { sessionID: d.sessionID });
            break;

          case "session.status": {
            const st = d.status;
            if (st?.type === "busy" || st?.type === "retry") statusMap.set(d.sessionID, st);
            else statusMap.delete(d.sessionID);
            emit("session.status", { sessionID: d.sessionID, status: st });
            break;
          }

          case "session.step.ended":
            emit("message.updated", {
              info: {
                role: "assistant",
                sessionID: d.sessionID,
                assistantMessageID: d.assistantMessageID,
                cost: d.cost,
                tokens: d.tokens,
              },
            });
            break;

          case "session.text.delta":
            emit("message.part.updated", { part: { sessionID: d.sessionID, type: "text" }, delta: d.delta });
            break;

          case "session.reasoning.delta":
            emit("message.part.updated", { part: { sessionID: d.sessionID, type: "reasoning" }, delta: d.delta });
            break;

          case "session.tool.called": {
            const name = classifyToolName(d.input);
            if (d.id) {
              toolNames.set(d.id, name);
              toolInputs.set(d.id, d.input);
            }
            emit("message.part.updated", {
              part: {
                sessionID: d.sessionID,
                type: "tool",
                id: d.id,
                tool: name || undefined,
                state: { status: "running", input: d.input, metadata: {} },
              },
            });
            break;
          }

          case "session.tool.progress":
            emit("message.part.updated", {
              part: {
                sessionID: d.sessionID,
                type: "tool",
                id: d.id,
                tool: d.id ? toolNames.get(d.id) || undefined : undefined,
                state: { status: "running", metadata: d.metadata ?? {} },
              },
            });
            break;

          case "session.tool.success": {
            const name = d.id ? toolNames.get(d.id) || "" : "";
            const contentText = ((d.content || []) as any[])
              .filter((c) => c?.type === "text")
              .map((c) => c?.text ?? "")
              .join("\n");
            const metadata = { ...(d.metadata ?? {}) };
            if (name === "task" && !metadata.sessionId) {
              const m = contentText.match(/ses_[A-Za-z0-9]+/);
              if (m) metadata.sessionId = m[0];
            }
            emit("message.part.updated", {
              part: {
                sessionID: d.sessionID,
                type: "tool",
                id: d.id,
                tool: name || undefined,
                state: { status: "completed", metadata, output: contentText },
              },
            });
            if (name === "todo") {
              const todos = d.id ? toolInputs.get(d.id)?.todos : undefined;
              if (Array.isArray(todos)) emit("todo.updated", { sessionID: d.sessionID, todos });
            }
            if (d.id) {
              toolNames.delete(d.id);
              toolInputs.delete(d.id);
            }
            break;
          }

          case "session.tool.failed":
            emit("message.part.updated", {
              part: {
                sessionID: d.sessionID,
                type: "tool",
                id: d.id,
                tool: d.id ? toolNames.get(d.id) || undefined : undefined,
                state: {
                  status: "error",
                  metadata: d.metadata ?? {},
                  error: typeof d.error === "string" ? d.error : d.error?.message,
                },
              },
            });
            if (d.id) {
              toolNames.delete(d.id);
              toolInputs.delete(d.id);
            }
            break;

          case "session.compaction.ended":
            emit("session.compacted", { sessionID: d.sessionID });
            break;

          case "file.edited":
          case "filesystem.changed": {
            const sid = singleResponseSession();
            if (sid) emit("file.edited", { sessionID: sid, path: d.file });
            break;
          }

          default:
            break;
        }
      }
    } catch (e) {
      log("event subscription ended:", (e as any)?.message || e);
    }
  })();

  return () => {
    try {
      ac.abort();
    } catch {}
  };
}

// ---------------------------------------------------------------------------
// Tool result mapping (V1 ToolResult -> V2 Tool.Result)
// ---------------------------------------------------------------------------

function mapToolResult(out: any): { content: any; metadata?: any } {
  if (typeof out === "string") return { content: out };
  if (out && typeof out === "object") {
    const content: any[] = [{ type: "text", text: typeof out.output === "string" ? out.output : JSON.stringify(out) }];
    for (const a of out.attachments ?? []) {
      content.push({ type: "file", uri: a.url, mime: a.mime, name: a.filename });
    }
    return { content, metadata: out.metadata };
  }
  return { content: JSON.stringify(out) };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "mattermost-control",
  async setup(ctx: any) {
    const directory = ctx.location.directory;
    log(`setup: directory=${directory}`);

    // 0) Mattermost credentials.
    // The unmodified legacy entry reads MATTERMOST_* from process.env via
    // src/config.ts#loadConfig(), which runs when we invoke it below — so
    // populating env here is safe. Values come from the plugin's options
    // block (opencode.json plugins entry), which take precedence over the
    // service environment:
    //
    //   { "package": "...", "options": { "mattermost": {
    //       "url": "https://mm.example.com/",
    //       "token": "<bot access token>"
    //   } } }
    //
    // Flat MATTERMOST_* keys directly under options are passed through as
    // well. MATTERMOST_WS_URL is derived from url when not given.
    const opts: Record<string, unknown> = (ctx.options ?? {}) as Record<string, unknown>;
    const mm = (opts.mattermost ?? {}) as Record<string, unknown>;
    const envInject: Record<string, string> = {};
    const put = (key: string, val: unknown) => {
      if (typeof val === "string" && val) envInject[key] = val;
    };
    put("MATTERMOST_URL", mm.url);
    put("MATTERMOST_TOKEN", mm.token);
    put("MATTERMOST_WS_URL", mm.wsUrl);
    put("MATTERMOST_TEAM", mm.team);
    put("MATTERMOST_BOT_USERNAME", mm.botUsername);
    put("MATTERMOST_OWNER_USER_ID", mm.ownerUserId);
    for (const [k, v] of Object.entries(opts)) {
      if (k.startsWith("MATTERMOST_") && typeof v === "string" && v) envInject[k] = v;
    }
    if (envInject.MATTERMOST_URL && !envInject.MATTERMOST_WS_URL) {
      const base = envInject.MATTERMOST_URL.replace(/\/+$/, "");
      envInject.MATTERMOST_WS_URL = base.replace(/^http/, "ws") + "/api/v4/websocket";
    }
    for (const [k, v] of Object.entries(envInject)) {
      process.env[k] = v;
      log(`mattermost env from options: ${k} set`);
    }

    // Live map of busy/retry sessions (fed by session.status events).
    const statusMap = new Map<string, any>();

    // 1) V1-compat HTTP server for the legacy fetches.
    const compat = await startCompatServer(directory);
    log(`V1-compat HTTP server listening on ${compat.url.origin}`);

    // 2) V1-style client shim.
    const client = buildClientShim(ctx, directory, statusMap);

    // 3) Run the unmodified V1 entry.
    const legacy = await (MattermostControlPlugin as any)({
      client,
      project: ctx.location.project,
      directory,
      serverUrl: compat.url,
      $: undefined,
    });
    log(`legacy entry loaded: ${Object.keys(legacy || {}).join(", ")}`);

    // 4) Event bridge.
    const stopEvents = startEventBridge(ctx, legacy?.event, statusMap);

    // 5) Tool execute hooks.
    const beforeReg = legacy?.["tool.execute.before"]
      ? ctx.tool.hook("execute.before", (ev: any) =>
          (legacy["tool.execute.before"] as any)({
            tool: ev.tool,
            sessionID: ev.sessionID,
            messageID: ev.messageID,
            agent: ev.agent,
            args: ev.input,
          })
        )
      : null;
    const afterReg = legacy?.["tool.execute.after"]
      ? ctx.tool.hook("execute.after", (ev: any) => {
          const resultText =
            ev.status === "completed"
              ? typeof ev.result?.content === "string"
                ? ev.result.content
                : ((ev.result?.content ?? []) as any[])
                    .filter((c) => c?.type === "text")
                    .map((c) => c?.text ?? "")
                    .join("\n")
              : undefined;
          return (legacy["tool.execute.after"] as any)({
            tool: ev.tool,
            sessionID: ev.sessionID,
            messageID: ev.messageID,
            agent: ev.agent,
            args: ev.input,
            result: resultText,
            metadata: ev.status === "completed" ? { output: resultText, ...(ev.result?.metadata ?? {}) } : undefined,
            error: ev.status === "error" ? ev.error?.message : undefined,
          });
        })
      : null;

    // 6) chat.message hook -> V2 "prompt" session hook (mirrors user prompts
    //    typed in the TUI into the Mattermost thread; the legacy handler
    //    itself skips injected "[Mattermost DM from @...]" prompts).
    const promptReg =
      typeof legacy?.["chat.message"] === "function"
        ? ctx.session.hook("prompt", (ev: any) => {
            try {
              return (legacy["chat.message"] as any)({ sessionID: ev.sessionID }, { parts: [{ type: "text", text: ev.prompt?.text ?? "" }] });
            } catch (e) {
              log("chat.message hook failed:", (e as any)?.message || e);
            }
          })
        : null;

    // 7) Register the plugin's tools.
    const toolReg = ctx.tool.transform((editor: any) => {
      for (const [name, def] of Object.entries<any>(legacy?.tool ?? {})) {
        let input: any = { type: "object" };
        const args = def?.args;
        if (args && typeof args === "object" && Object.keys(args).length > 0) {
          try {
            input = z.toJSONSchema(args);
          } catch (e) {
            log(`could not convert zod args for tool ${name}:`, (e as any)?.message || e);
          }
        }
        editor.add({
          name,
          description: def?.description || name,
          input,
          execute: async (inp: any, v2ctx: any) => {
            const out = await def.execute(inp ?? {}, {
              sessionID: v2ctx.sessionID,
              messageID: v2ctx.messageID,
              agent: v2ctx.agent,
              directory,
              worktree: undefined,
              abort: v2ctx.signal,
              metadata: () => ({}),
              ask: async () => ({}),
            });
            return mapToolResult(out);
          },
        });
      }
    });
    log(`registered ${Object.keys(legacy?.tool ?? {}).length} tools`);

    // 8) Cleanup.
    return async () => {
      log("cleanup");
      stopEvents();
      try {
        beforeReg?.dispose?.();
        afterReg?.dispose?.();
        promptReg?.dispose?.();
        toolReg?.dispose?.();
      } catch {}
      try {
        PluginState.disconnect();
      } catch (e) {
        log("PluginState.disconnect failed:", (e as any)?.message || e);
      }
      await compat.close();
    };
  },
});
