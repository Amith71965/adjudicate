import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

describe("adjudicate MCP server over stdio", () => {
  it("completes a real initialize handshake and lists its tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs"), path.resolve(__dirname, "../mcp/stdio.ts")],
      env: { ...process.env, ADJUDICATE_API: "http://127.0.0.1:9" } as Record<string, string>,
    });
    const client = new Client({ name: "handshake-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("adjudicate");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(3);
    } finally {
      await client.close();
    }
  }, 30_000);
});
