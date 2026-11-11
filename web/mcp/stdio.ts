/** stdio entry point: `npx tsx mcp/stdio.ts` (ADJUDICATE_API defaults to http://127.0.0.1:8000). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

async function main(): Promise<void> {
  const server = createServer({ apiBase: process.env.ADJUDICATE_API ?? "http://127.0.0.1:8000" });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`adjudicate MCP server failed to start: ${String(err)}\n`);
  process.exit(1);
});
