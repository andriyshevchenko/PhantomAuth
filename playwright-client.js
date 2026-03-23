import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let client = null;
let connected = false;

export async function connectToPlaywright(url) {
  if (connected && client) return client;

  const transport = new StreamableHTTPClientTransport(new URL(url));
  client = new Client({ name: 'phantomauth', version: '0.1.0' });
  await client.connect(transport);
  connected = true;
  return client;
}

export async function callPlaywrightTool(url, toolName, args) {
  const c = await connectToPlaywright(url);
  const result = await c.callTool({ name: toolName, arguments: args });
  return result;
}

export async function disconnectPlaywright() {
  if (client && connected) {
    try { await client.close(); } catch { /* ignore */ }
    connected = false;
    client = null;
  }
}
