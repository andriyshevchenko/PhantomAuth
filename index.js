#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getSecretByTitle, resolveProfile, listSecrets, listProfiles } from './vault-resolver.js';
import { fillField, typeIntoField, pressEnter, disconnectPlaywright } from './playwright-client.js';

const PLAYWRIGHT_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://localhost:8931/mcp';

const server = new McpServer({
  name: 'PhantomAuth',
  version: '0.1.0',
});

// --- Tool: secure_fill ---
server.tool(
  'secure_fill',
  `Fill a form field with a secret value from SecureVault. The AI agent never sees the raw credential — only the secret's title is passed. The value is resolved from the OS keychain and sent directly to Playwright via JavaScript injection.`,
  {
    secretTitle: z.string().describe('The title/name of the secret in SecureVault (e.g. "Microsoft Email", "GitHub Token")'),
    selector: z.string().describe('CSS selector of the input field to fill (e.g. "input[name=email]", "#password")'),
  },
  async ({ secretTitle, selector }) => {
    try {
      const value = await getSecretByTitle(secretTitle);
      await fillField(PLAYWRIGHT_URL, selector, value);
      return {
        content: [{ type: 'text', text: `✅ Filled "${selector}" with secret "${secretTitle}" (value hidden from agent)` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to fill: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: secure_type ---
server.tool(
  'secure_type',
  `Type a secret value character-by-character into a form field. Unlike secure_fill, this simulates individual keystrokes via JavaScript events. Use when fill doesn't work (e.g. React-controlled inputs with strict validation).`,
  {
    secretTitle: z.string().describe('The title/name of the secret in SecureVault'),
    selector: z.string().optional().describe('Optional CSS selector. If omitted, types into the currently focused element'),
    pressEnterAfter: z.boolean().optional().default(false).describe('Whether to press Enter after typing'),
  },
  async ({ secretTitle, selector, pressEnterAfter }) => {
    try {
      const value = await getSecretByTitle(secretTitle);

      await typeIntoField(PLAYWRIGHT_URL, selector, value);

      if (pressEnterAfter) {
        await pressEnter(PLAYWRIGHT_URL);
      }

      return {
        content: [{ type: 'text', text: `✅ Typed secret "${secretTitle}" ${selector ? `into "${selector}"` : 'into focused element'}${pressEnterAfter ? ' and pressed Enter' : ''} (value hidden from agent)` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to type: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: secure_authenticate ---
server.tool(
  'secure_authenticate',
  `Execute a multi-step authentication flow using a SecureVault profile. Each step fills a form field with a resolved secret from the profile. The agent orchestrates the flow without ever seeing credentials.`,
  {
    profileName: z.string().describe('Name of the SecureVault profile containing the authentication secrets'),
    steps: z.array(z.object({
      selector: z.string().describe('CSS selector of the input field'),
      envVar: z.string().describe('The environment variable name from the profile mapping (e.g. "EMAIL", "PASSWORD")'),
      action: z.enum(['fill', 'type']).default('fill').describe('Whether to fill or type the value'),
      pressEnterAfter: z.boolean().optional().default(false).describe('Press Enter after this step'),
      waitMs: z.number().optional().describe('Milliseconds to wait after this step (for page transitions)'),
    })).describe('Ordered list of form fields to fill with secrets from the profile'),
  },
  async ({ profileName, steps }) => {
    try {
      const resolved = await resolveProfile(profileName);
      const results = [];

      for (const step of steps) {
        const entry = resolved[step.envVar];
        if (!entry) {
          results.push(`⚠️ Skipped "${step.envVar}" — not found in profile "${profileName}"`);
          continue;
        }

        if (step.action === 'fill') {
          await fillField(PLAYWRIGHT_URL, step.selector, entry.value);
        } else {
          await typeIntoField(PLAYWRIGHT_URL, step.selector, entry.value);
        }

        if (step.pressEnterAfter) {
          await pressEnter(PLAYWRIGHT_URL);
        }

        if (step.waitMs) {
          await new Promise(resolve => setTimeout(resolve, step.waitMs));
        }

        results.push(`✅ ${step.action === 'fill' ? 'Filled' : 'Typed'} "${step.envVar}" → "${step.selector}" (value hidden)`);
      }

      return {
        content: [{ type: 'text', text: `Authentication flow for profile "${profileName}":\n${results.join('\n')}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Authentication failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: list_vault_secrets ---
server.tool(
  'list_vault_secrets',
  'List available secrets in SecureVault (titles only — values are never exposed)',
  {},
  async () => {
    try {
      const secrets = await listSecrets();
      if (secrets.length === 0) {
        return { content: [{ type: 'text', text: 'No secrets found in SecureVault' }] };
      }
      const list = secrets.map(s => `• ${s.title}${s.category ? ` [${s.category}]` : ''}`).join('\n');
      return { content: [{ type: 'text', text: `Available secrets:\n${list}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Failed to list secrets: ${err.message}` }], isError: true };
    }
  }
);

// --- Tool: list_vault_profiles ---
server.tool(
  'list_vault_profiles',
  'List available SecureVault profiles and their env var → secret mappings',
  {},
  async () => {
    try {
      const profiles = await listProfiles();
      if (profiles.length === 0) {
        return { content: [{ type: 'text', text: 'No profiles found in SecureVault' }] };
      }
      const text = profiles.map(p => {
        const mappings = p.mappings.map(m => `  ${m.envVar} → "${m.secretTitle}"`).join('\n');
        return `📋 ${p.name}\n${mappings}`;
      }).join('\n\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Failed to list profiles: ${err.message}` }], isError: true };
    }
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await disconnectPlaywright();
    await server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('PhantomAuth failed to start:', err);
  process.exit(1);
});
