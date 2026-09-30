import type { ToolReply } from "./format.ts";

const TRACE_ENV = "OPENTAKEOFF_MCP_TRACE";

export function traceToolCall(tool: string, args: unknown, startedAt: bigint, reply: ToolReply): void {
  if (process.env[TRACE_ENV] !== "1") return;

  // result_size spans every part — for image tools that's meta + base64 bytes
  const text = reply.content.map((c) => ("text" in c ? c.text : c.data)).join("");
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const a = args && typeof args === "object" ? (args as { sheet?: unknown; action?: unknown; kind?: unknown }) : {};
  const action = a.action ?? a.kind;

  const event = {
    event: "opentakeoff_mcp_tool_call",
    tool,
    duration_ms: Math.round(durationMs * 100) / 100,
    action: typeof action === "string" ? action : null,
    sheet: typeof a.sheet === "string" ? a.sheet : null,
    result_size: text.length,
    is_error: reply.isError === true,
  };

  process.stderr.write(`${JSON.stringify(event)}\n`);
}
