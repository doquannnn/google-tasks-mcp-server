// Tiny MCP client that talks to our server over stdio (or HTTP with MCP_URL), used by import + tests.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';

export async function connect(env: Record<string, string> = {}) {
  const client = new Client({ name: 'gtasks-script', version: '0.1.0' });
  if (process.env.MCP_URL) {
    const headers: Record<string, string> = process.env.MCP_AUTH_TOKEN ? { authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {};
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), { requestInit: { headers } }));
  } else {
    const serverPath = fileURLToPath(new URL('../src/server.ts', import.meta.url));
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...(process.env as any), ...env }, stderr: 'inherit' }),
    );
  }
  const call = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  return { client, call, close: () => client.close() };
}
