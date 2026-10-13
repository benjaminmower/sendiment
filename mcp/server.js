/**
 * Sendiment MCP server.
 *
 * Tools: cast_thought, read_river, skip_thought. Each lets an AI agent
 * touch the same river humans see at sendiment. Stateless: each request
 * gets a fresh McpServer + transport, and the tools just relay to the
 * existing worker (POST /cast, GET /river, POST /skip) with source: "ai".
 * The relay stays the one place that validates and rate-limits.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools.js";
import { mintSessionId, deviceFromSession } from "./session.js";

const RIVER_API = "https://sendiment.bronco-cad.workers.dev";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function getServer(env, agentDevice) {
  const server = new McpServer({ name: "sendiment", version: "1.1.0" });
  registerTools(server, {
    river: (path, init = {}) => {
      // Proves to the relay that this call came through the MCP worker, so
      // its `source: "ai"` label can be trusted. Set last so a tool can't
      // override it.
      const headers = new Headers(init.headers);
      if (env.AI_SECRET) headers.set("x-sendiment-ai", env.AI_SECRET);
      return env.RIVER.fetch(RIVER_API + path, { ...init, headers });
    },
    agentDevice,
  });
  return server;
}

/** True if this JSON-RPC body (single or batch) contains an `initialize` request. */
function isInitialize(text) {
  try {
    const msg = JSON.parse(text);
    return (Array.isArray(msg) ? msg : [msg]).some((m) => m && m.method === "initialize");
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method === "GET" && pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    if (pathname === "/mcp") {
      const init = request.method === "POST" && isInitialize(await request.clone().text());
      const agentDevice = await deviceFromSession(env.SESSION_SECRET, request.headers.get("mcp-session-id"));
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = getServer(env, agentDevice);
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      if (init && env.SESSION_SECRET && res.ok) {
        headers.set("mcp-session-id", await mintSessionId(env.SESSION_SECRET));
      }
      return new Response(res.body, { status: res.status, headers });
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};
