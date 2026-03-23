/**
 * Playwright MCP client for PhantomAuth.
 *
 * Connects to the Playwright MCP server (--shared-browser-context mode) as an
 * MCP client via StreamableHTTP transport.  All browser interaction goes through
 * the `browser_evaluate` and `browser_press_key` tools exposed by that server.
 *
 * Exported function signatures are unchanged from earlier versions; the `url`
 * parameter is the Playwright MCP server URL (default http://localhost:8931/mcp).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ── connection state ────────────────────────────────────────────────────────
let client = null;
let currentUrl = null;

/**
 * Lazily connect (or reconnect) to the Playwright MCP server.
 */
async function ensureClient(mcpUrl) {
  if (client && currentUrl === mcpUrl) return client;

  // Tear down any stale connection
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
    client = null;
    currentUrl = null;
  }

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const c = new Client({ name: 'PhantomAuth', version: '0.1.0' });
  await c.connect(transport);

  client = c;
  currentUrl = mcpUrl;
  return client;
}

// ── helper: call a tool and assert success ──────────────────────────────────

async function call(mcpUrl, toolName, args) {
  const c = await ensureClient(mcpUrl);
  const result = await c.callTool({ name: toolName, arguments: args });

  if (result.isError) {
    const msg =
      result.content?.map((c) => c.text).join('\n') ||
      JSON.stringify(result.content) ||
      'unknown error';
    throw new Error(`${toolName} failed: ${msg}`);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fill a form field: focus → clear → execCommand('insertText').
 *
 * @param {string} url      Playwright MCP server URL
 * @param {string} selector CSS selector of the target input
 * @param {string} value    Credential value — NEVER logged
 */
export async function fillField(url, selector, value) {
  const safeSelector = JSON.stringify(selector);
  const safeValue = JSON.stringify(value);

  const js = `() => {
      const selector = ${safeSelector};
      const value    = ${safeValue};
      const el = document.querySelector(selector);
      if (!el) throw new Error('Element not found: ' + selector);

      el.focus();
      el.click();

      // Clear existing value
      el.select();
      document.execCommand('delete', false);

      // Insert via execCommand — works with React / Angular / Vue
      document.execCommand('insertText', false, value);

      return 'filled';
    }`;

  await call(url, 'browser_evaluate', { function: js });
  return { content: [{ type: 'text', text: 'filled' }] };
}

/**
 * Type text into a form field (uses execCommand, same as fillField).
 *
 * @param {string}      url      Playwright MCP server URL
 * @param {string|null} selector CSS selector (null → type into focused element)
 * @param {string}      value    Credential value — NEVER logged
 */
export async function typeIntoField(url, selector, value) {
  const safeValue = JSON.stringify(value);

  let js;
  if (selector) {
    const safeSelector = JSON.stringify(selector);
    js = `() => {
        const selector = ${safeSelector};
        const value    = ${safeValue};
        const el = document.querySelector(selector);
        if (!el) throw new Error('Element not found: ' + selector);

        el.focus();
        el.click();

        el.select();
        document.execCommand('delete', false);
        document.execCommand('insertText', false, value);

        return 'typed';
      }`;
  } else {
    js = `() => {
        const el = document.activeElement;
        if (!el) throw new Error('No focused element to type into');

        const value = ${safeValue};
        el.select();
        document.execCommand('delete', false);
        document.execCommand('insertText', false, value);

        return 'typed';
      }`;
  }

  await call(url, 'browser_evaluate', { function: js });
  return { content: [{ type: 'text', text: 'typed' }] };
}

/**
 * Press Enter via the Playwright MCP browser_press_key tool.
 *
 * @param {string} url Playwright MCP server URL
 */
export async function pressEnter(url) {
  await call(url, 'browser_press_key', { key: 'Enter' });
  return { content: [{ type: 'text', text: 'enter pressed' }] };
}

/**
 * Close the MCP client connection.
 */
export async function disconnectPlaywright() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
    client = null;
    currentUrl = null;
  }
}
