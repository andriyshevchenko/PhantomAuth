/**
 * CDP (Chrome DevTools Protocol) client for PhantomAuth.
 *
 * Connects to an ALREADY-RUNNING browser via its --remote-debugging-port.
 * Uses raw HTTP fetch + built-in WebSocket (Node 22+). No heavy dependencies.
 *
 * Exported function signatures are unchanged from the old Playwright MCP version;
 * the `url` parameter now means the CDP base URL (default http://localhost:65533).
 */

const DEFAULT_CDP_URL = 'http://localhost:65533';

// ── connection state ────────────────────────────────────────────────────────
let ws = null;
let msgId = 0;
const pendingMessages = new Map();
let currentCdpUrl = null;

// ── CDP target discovery ────────────────────────────────────────────────────

/**
 * GET /json on the debug port and return the first real page target.
 */
async function discoverPageTarget(cdpBaseUrl) {
  const endpoint = `${cdpBaseUrl}/json`;
  const resp = await fetch(endpoint);
  if (!resp.ok) {
    throw new Error(`CDP discovery failed: HTTP ${resp.status} from ${endpoint}`);
  }
  const targets = await resp.json();

  // Prefer a genuine page (not about:blank), fall back to any page
  const page =
    targets.find((t) => t.type === 'page' && t.url !== 'about:blank') ||
    targets.find((t) => t.type === 'page');

  if (!page) {
    throw new Error('No page targets found via CDP. Is the browser open with a page?');
  }
  return page;
}

// ── WebSocket transport ─────────────────────────────────────────────────────

function connectToTarget(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);

    socket.addEventListener('open', () => resolve(socket));

    socket.addEventListener('error', (err) => {
      reject(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
    });

    socket.addEventListener('message', (event) => {
      try {
        const data =
          typeof event.data === 'string' ? event.data : event.data.toString();
        const msg = JSON.parse(data);
        if (msg.id !== undefined && pendingMessages.has(msg.id)) {
          const { resolve: res, reject: rej } = pendingMessages.get(msg.id);
          pendingMessages.delete(msg.id);
          if (msg.error) {
            rej(new Error(`CDP error: ${msg.error.message} (code ${msg.error.code})`));
          } else {
            res(msg.result);
          }
        }
      } catch {
        /* ignore non-JSON / event messages */
      }
    });

    socket.addEventListener('close', () => {
      for (const [id, { reject: rej }] of pendingMessages) {
        rej(new Error('WebSocket closed'));
        pendingMessages.delete(id);
      }
      if (ws === socket) {
        ws = null;
        currentCdpUrl = null;
      }
    });
  });
}

/**
 * Lazily (re-)connect so every exported call just works.
 */
async function ensureConnection(cdpBaseUrl) {
  const baseUrl = cdpBaseUrl || DEFAULT_CDP_URL;

  if (ws && ws.readyState === WebSocket.OPEN && currentCdpUrl === baseUrl) {
    return ws;
  }

  // Tear down stale connection
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  const target = await discoverPageTarget(baseUrl);
  ws = await connectToTarget(target.webSocketDebuggerUrl);
  currentCdpUrl = baseUrl;
  return ws;
}

// ── CDP command helper ──────────────────────────────────────────────────────

function cdpSend(socket, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingMessages.delete(id);
      reject(new Error(`CDP "${method}" timed out after 15 s`));
    }, 15_000);

    pendingMessages.set(id, {
      resolve: (r) => { clearTimeout(timeout); resolve(r); },
      reject:  (e) => { clearTimeout(timeout); reject(e); },
    });

    socket.send(JSON.stringify({ id, method, params }));
  });
}

// ── Runtime.evaluate wrapper ────────────────────────────────────────────────

async function evaluate(cdpBaseUrl, expression) {
  const socket = await ensureConnection(cdpBaseUrl);
  const result = await cdpSend(socket, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    const desc =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Unknown evaluation error';
    throw new Error(`Page JS error: ${desc}`);
  }

  return result.result?.value;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Public API — same signatures as the old Playwright-MCP version
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fill a form field: focus → clear → insertText.
 *
 * @param {string} url      CDP base URL (default http://localhost:65533)
 * @param {string} selector CSS selector of the target input
 * @param {string} value    Credential value — NEVER logged
 */
export async function fillField(url, selector, value) {
  const safeSelector = JSON.stringify(selector);
  const safeValue    = JSON.stringify(value);       // handles every special char

  const expression = `
    (() => {
      const selector = ${safeSelector};
      const value    = ${safeValue};
      const el = document.querySelector(selector);
      if (!el) throw new Error('Element not found: ' + selector);

      el.focus();
      el.click();

      // Clear existing value — select-all + delete
      el.select();
      document.execCommand('delete', false);

      // Insert via execCommand — works with React / Angular / Vue
      document.execCommand('insertText', false, value);

      return 'filled';
    })()`;

  await evaluate(url, expression);
  return { content: [{ type: 'text', text: 'filled' }] };
}

/**
 * Type text character-by-character (KeyboardEvents + execCommand per char).
 *
 * @param {string}      url      CDP base URL
 * @param {string|null} selector CSS selector (null → type into focused element)
 * @param {string}      value    Credential value — NEVER logged
 */
export async function typeIntoField(url, selector, value) {
  if (selector) {
    const safeSelector = JSON.stringify(selector);
    await evaluate(url, `
      (() => {
        const el = document.querySelector(${safeSelector});
        if (!el) throw new Error('Element not found: ' + ${safeSelector});
        el.focus();
        el.click();
        return 'focused';
      })()`);
  }

  const safeValue = JSON.stringify(value);

  const expression = `
    (() => {
      const el = document.activeElement;
      if (!el) throw new Error('No focused element to type into');

      const text = ${safeValue};
      for (const char of text) {
        el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));
        document.execCommand('insertText', false, char);
        el.dispatchEvent(new KeyboardEvent('keyup',    { key: char, bubbles: true, cancelable: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed';
    })()`;

  await evaluate(url, expression);
  return { content: [{ type: 'text', text: 'typed' }] };
}

/**
 * Press Enter on the active element and submit the closest form.
 *
 * @param {string} url CDP base URL
 */
export async function pressEnter(url) {
  const expression = `
    (() => {
      const el = document.activeElement || document.body;
      const opts = {
        key: 'Enter', code: 'Enter',
        keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      };

      el.dispatchEvent(new KeyboardEvent('keydown',  opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup',    opts));

      // Also submit closest form if possible
      const form = el.closest && el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.submit();
        }
      }

      return 'enter pressed';
    })()`;

  await evaluate(url, expression);
  return { content: [{ type: 'text', text: 'enter pressed' }] };
}

/**
 * Close the CDP WebSocket connection.
 */
export async function disconnectPlaywright() {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
    currentCdpUrl = null;
    pendingMessages.clear();
  }
}
