#!/usr/bin/env -S node --import tsx
import { openSync, writeSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { SessionManager } from "./session.js";

// RISEUP_LOG_FILE: also write the log there, e.g. /proc/1/fd/2 when an MCP
// proxy that drops its servers' stderr runs as the container's main process.
if (process.env.RISEUP_LOG_FILE) {
  try {
    const fd = openSync(process.env.RISEUP_LOG_FILE, "a");
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      try {
        if (typeof chunk === "string") writeSync(fd, chunk);
        else writeSync(fd, chunk);
      } catch {
        // The log file is a convenience; stderr still has everything.
      }
      return write(chunk, ...rest);
    }) as typeof process.stderr.write;
  } catch (err) {
    console.error(`[riseup-mcp] cannot open RISEUP_LOG_FILE: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const session = new SessionManager();
await session.start();
const server = createMcpServer(session);
const transport = new StdioServerTransport();
transport.onclose = () => session.stop();
await server.connect(transport);
