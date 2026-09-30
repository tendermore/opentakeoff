// The Streamable HTTP entry (http.ts): the bearer secret is required, each MCP
// session gets its own takeoff Session, and the tools answer as on stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../http.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const TOKEN = "test-token-0123456789";

async function started() {
  const { server, sessions } = startHttpServer({ token: TOKEN, port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  return { server, sessions, base };
}
const client = async (base: string, token = TOKEN) => {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};
const text = (r: any) => JSON.parse(r.content.find((p: any) => p.type === "text").text);

test("refuses to start without a secret; health is open, /mcp needs the bearer secret", async () => {
  assert.throws(() => startHttpServer({ token: "" }), /OPENTAKEOFF_HTTP_TOKEN/);
  const { server, base } = await started();
  try {
    assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    await assert.rejects(client(base, "wrong-token-0123456789"));
  } finally { server.close(); }
});

test("each session has its own takeoff: a plan loaded in one is not in the other", async () => {
  const { server, sessions, base } = await started();
  try {
    const a = await client(base), b = await client(base);
    assert.equal(sessions(), 2);
    const loaded = text(await a.callTool({ name: "open_drawings", arguments: { action: "load", path: PLAN } }));
    assert.ok(loaded.sheets.length > 0);
    const aInfo = await a.callTool({ name: "open_drawings", arguments: { action: "info" } });
    const bInfo = await b.callTool({ name: "open_drawings", arguments: { action: "info" } });
    assert.ok(JSON.stringify(aInfo).includes("sample-plan.pdf"), "session a lists its plan");
    assert.ok(!JSON.stringify(bInfo).includes("sample-plan.pdf"), "session b never saw a's plan");
    await a.close(); await b.close();
  } finally { server.close(); }
});
