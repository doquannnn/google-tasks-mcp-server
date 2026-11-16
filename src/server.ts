#!/usr/bin/env node
// Google Tasks MCP server.
//   stdio (default):   node src/server.ts
//   Streamable HTTP:   node src/server.ts --http   (PORT, HOST, MCP_AUTH_TOKEN env vars)
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GoogleTasksClient, loadCreds } from './google-tasks.ts';
import { registerTools } from './tools.ts';

const api = new GoogleTasksClient(loadCreds());

function buildServer() {
  const server = new McpServer({ name: 'google-tasks-mcp', version: '0.1.0' });
  registerTools(server, api);
  return server;
}

if (!process.argv.includes('--http')) {
  await buildServer().connect(new StdioServerTransport());
} else {
  const PORT = Number(process.env.PORT ?? 8787);
  const HOST = process.env.HOST ?? '127.0.0.1';
  const TOKEN = process.env.MCP_AUTH_TOKEN;
  if (!TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.error('Refusing to listen on a public interface without MCP_AUTH_TOKEN.');
    process.exit(1);
  }

  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') return void res.writeHead(200).end('ok');
    if (url.pathname !== '/mcp') return void res.writeHead(404).end('not found');
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('unauthorized');
    }
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream / session to GET or DELETE.
      return void res.writeHead(405, { allow: 'POST' }).end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return void res.writeHead(400).end('invalid json');
    }
    // Stateless mode: a fresh server+transport per request (simplest, scales horizontally on Cloud Run).
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }).listen(PORT, HOST, () => console.error(`google-tasks-mcp listening on http://${HOST}:${PORT}/mcp`));
}
