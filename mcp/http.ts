// OpenTakeoff MCP server over Streamable HTTP — the same tools as server.ts,
// for a host that runs the engine as its own process (a sandbox, a service)
// and reaches it over a port instead of stdio.
// Run: OPENTAKEOFF_HTTP_TOKEN=<secret> node --import tsx http.ts
//
// Each MCP session gets its own takeoff Session, so one process serves several
// clients without their plans, scales or shapes meeting. Every request carries
// the bearer secret; there is no anonymous access (only GET /healthz is open).
import "./src/hush.ts"; // must stay the FIRST import (see server.ts)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Session } from "./src/session.ts";
import { buildServer } from "./server.ts";

export interface HttpServerOptions {
  token: string;
  host?: string;
  port?: number;
  /** A session idle this long is closed and its memory released. */
  idleMs?: number;
  /** Refuse new sessions past this many live ones. */
  maxSessions?: number;
  /** Largest JSON request body accepted. */
  maxBodyBytes?: number;
}

interface Live { transport: StreamableHTTPServerTransport; seen: number }

export function startHttpServer(opts: HttpServerOptions) {
  if (!opts.token || opts.token.length < 16) throw new Error("OPENTAKEOFF_HTTP_TOKEN must be set (at least 16 characters).");
  const idleMs = opts.idleMs ?? 45 * 60_000;
  const maxSessions = opts.maxSessions ?? 32;
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const want = Buffer.from(`Bearer ${opts.token}`);
  const live = new Map<string, Live>();

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const reply = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };
  const readJson = (req: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > maxBody) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); } catch (e) { reject(e); } });
    req.on("error", reject);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (url.pathname !== "/mcp") return reply(res, 404, "Not found");
    if (!authorized(req)) return reply(res, 401, "Unauthorized");
    const id = req.headers["mcp-session-id"];
    const sessionId = typeof id === "string" ? id : undefined;
    try {
      if (req.method === "POST") {
        const body = await readJson(req);
        const existing = sessionId ? live.get(sessionId) : undefined;
        if (existing) { existing.seen = Date.now(); return await existing.transport.handleRequest(req, res, body); }
        if (sessionId || !isInitializeRequest(body)) return reply(res, 404, "Unknown or expired session: initialize a new one");
        if (live.size >= maxSessions) return reply(res, 503, "Too many open sessions");
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { live.set(sid, { transport, seen: Date.now() }); },
        });
        transport.onclose = () => { if (transport.sessionId) live.delete(transport.sessionId); };
        await buildServer(new Session()).connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const existing = sessionId ? live.get(sessionId) : undefined;
        if (!existing) return reply(res, 404, "Unknown or expired session");
        existing.seen = Date.now();
        return await existing.transport.handleRequest(req, res);
      }
      return reply(res, 405, "Method not allowed");
    } catch (error) {
      if (!res.headersSent) reply(res, 400, error instanceof Error ? error.message : "Bad request");
    }
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [sid, s] of live) if (s.seen < cutoff) { live.delete(sid); void s.transport.close(); }
  }, Math.min(idleMs, 60_000));
  sweep.unref();
  server.on("close", () => { clearInterval(sweep); for (const s of live.values()) void s.transport.close(); live.clear(); });
  server.listen(opts.port ?? 8765, opts.host ?? "127.0.0.1");
  return { server, sessions: () => live.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const num = (v: string | undefined) => (v ? Number(v) : undefined);
  const { server } = startHttpServer({
    token: process.env.OPENTAKEOFF_HTTP_TOKEN ?? "",
    host: process.env.OPENTAKEOFF_HTTP_HOST,
    port: num(process.env.OPENTAKEOFF_HTTP_PORT),
    idleMs: num(process.env.OPENTAKEOFF_HTTP_IDLE_MS),
    maxSessions: num(process.env.OPENTAKEOFF_HTTP_MAX_SESSIONS),
  });
  server.on("listening", () => {
    const a = server.address();
    process.stderr.write(`opentakeoff http listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : String(a)}\n`);
  });
}
