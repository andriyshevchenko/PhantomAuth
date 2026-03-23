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
  if (result.isError) {
    const msg = result.content?.map(c => c.text || '').join('\n') || 'Unknown Playwright error';
    throw new Error(`Playwright "${toolName}" failed: ${msg}`);
  }
  return result;
}

/**
 * Fill a form field using JavaScript evaluation.
 * Uses CSS selector to find the element, sets its value, and dispatches
 * input/change events so frameworks (React, Angular, etc.) detect the change.
 */
export async function fillField(url, selector, value) {
  const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return callPlaywrightTool(url, 'browser_evaluate', {
    function: `() => {
      const el = document.querySelector('${escapedSelector}');
      if (!el) throw new Error('Element not found: ${escapedSelector}');
      
      // Focus the element
      el.focus();
      el.click();
      
      // Clear existing value — select all then delete
      el.select();
      document.execCommand('delete', false);
      
      // Insert text via execCommand — goes through the browser's editing pipeline
      // which React/Angular/Vue controlled inputs detect correctly
      document.execCommand('insertText', false, '${escapedValue}');
      
      return 'filled';
    }`,
  });
}

/**
 * Type text character-by-character using JavaScript.
 * Falls back to setting value + events if keystroke simulation fails.
 */
export async function typeIntoField(url, selector, value) {
  if (selector) {
    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // First click to focus
    await callPlaywrightTool(url, 'browser_evaluate', {
      function: `() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) throw new Error('Element not found: ${escapedSelector}');
        el.focus();
        el.click();
        return 'focused';
      }`,
    });
  }

  // Type character by character using keyboard events
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return callPlaywrightTool(url, 'browser_evaluate', {
    function: `() => {
      const el = document.activeElement;
      if (!el) throw new Error('No focused element to type into');
      
      const text = '${escapedValue}';
      for (const char of text) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        
        // Use native setter to bypass React controlled input guards
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, el.value + char);
        } else {
          el.value += char;
        }
        
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      
      return 'typed';
    }`,
  });
}

/**
 * Press Enter key on the active element.
 */
export async function pressEnter(url) {
  return callPlaywrightTool(url, 'browser_press_key', { key: 'Enter' });
}

export async function disconnectPlaywright() {
  if (client && connected) {
    try { await client.close(); } catch { /* ignore */ }
    connected = false;
    client = null;
  }
}
