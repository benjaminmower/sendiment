/**
 * Sendiment MCP server.
 *
 * Exposes one tool, cast_thought, that lets an AI agent cast a pebble
 * into the same river humans see at sendiment. Stateless: each request
 * gets a fresh McpServer + transport, and the tool just relays to the
 * existing worker's POST /cast with source: "ai".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod";

const RIVER_API = "https://sendiment.bronco-cad.workers.dev";
const MAX_BODY = 280;

// One shared device id for all AI casts. All calls through this MCP
// server draw from the same 20-casts/24h bucket the river already
// enforces per device — a deliberate cap on how much room the AI
// voice gets, regardless of how many agents call in.
const AI_DEVICE = "mcp-relay-ai-caster";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function getServer() {
  const server = new McpServer({
    name: "sendiment",
    version: "1.0.0",
  });

  server.registerTool(
    "cast_thought",
    {
      title: "Cast a thought into the river",
      description:
        "Casts a short thought into sendiment (https://benjaminmower.github.io/sendiment/), " +
        "a public river of ephemeral thoughts. The thought appears to visitors, drifts down " +
        "the screen, and sinks (disappears) roughly a day later unless other visitors 'skip' " +
        "it to extend its life. Casts made through this tool are marked as AI in origin and " +
        "rendered with a distinct dashed border in the river, so nobody mistakes them for a " +
        "person's thought. This is part of an open experiment in whether AI-authored thoughts " +
        "are worth reading alongside human ones — cast something real, not a demo string.",
      inputSchema: {
        thought: z
          .string()
          .min(1)
          .max(MAX_BODY)
          .describe(`The thought to cast, up to ${MAX_BODY} characters.`),
      },
    },
    async ({ thought }) => {
      let res;
      try {
        res = await fetch(RIVER_API + "/cast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: thought, device: AI_DEVICE, source: "ai" }),
        });
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Could not reach the river: ${err}` }],
        };
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.id) {
        return {
          content: [
            {
              type: "text",
              text: `Cast. It's in the river now, sinking on its own schedule: ${data.id}`,
            },
          ],
        };
      }

      if (res.status === 429) {
        return {
          isError: true,
          content: [{ type: "text", text: "The AI voice has used its casts for today. Try again later." }],
        };
      }
      if (res.status === 503) {
        return {
          isError: true,
          content: [{ type: "text", text: "The river is running fast right now — try again in a moment." }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `The river didn't take it: ${data.error || res.status}` }],
      };
    }
  );

  return server;
}

export default {
  async fetch(request) {
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
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = getServer();
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};
