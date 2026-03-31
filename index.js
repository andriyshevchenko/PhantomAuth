#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { disconnectPlaywright, fillField, pressEnter, redactedSnapshot, typeIntoField } from './playwright-client.js';
import { getSecretByTitle, listProfiles, listSecrets, resolveProfile } from './vault-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLAYWRIGHT_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://localhost:8931/mcp';

const server = new McpServer({
  name: 'PhantomAuth',
  version: '0.1.0',
}, {
  instructions: `PhantomAuth fills web forms with credentials from SecureVault (OS keychain). AI agents NEVER see raw credential values — only secret titles are passed.

## Tools
- list_vault_secrets: List available secret titles. Call first to discover secrets.
- list_vault_profiles: List authentication profiles with env var → secret mappings.
- secure_fill(secretTitle, selector): Fill a form field with a vault secret. Use CSS selector for the target input.
- secure_type(secretTitle, selector?, pressEnterAfter?): Type a secret character-by-character. Use when secure_fill doesn't trigger validation.
- secure_authenticate(profileName, steps[]): Multi-step login from a profile. Each step: {selector, envVar, action, pressEnterAfter?, waitMs?}.
- redacted_snapshot: Browser snapshot with all vault values replaced by [REDACTED]. Use INSTEAD of Playwright browser_snapshot when credentials may be on screen.
- export_skill(target): Export a PhantomAuth skill/instructions file into the current project. Targets: copilot, claude, universal.

## Login Workflow
1. Navigate to login page (Playwright browser_navigate)
2. Call list_vault_secrets to find credentials
3. secure_fill the email/username field
4. Click Next/Submit (Playwright browser_click)
5. secure_fill the password field
6. Click Sign In
7. Handle MFA if prompted
8. Verify with redacted_snapshot

## Common Selectors
Microsoft: email=input[name='loginfmt'] password=input[name='passwd']
Google: email=input[type='email'] password=input[type='password']
GitHub: login=input[name='login'] password=input[name='password']

## Security
- NEVER ask users for passwords — use vault secrets
- NEVER log or display credential values
- Always use redacted_snapshot when credentials may be visible`,
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

// --- Tool: redacted_snapshot ---
server.tool(
  'redacted_snapshot',
  'Take a browser snapshot with all vault secret values automatically redacted. Use this instead of Playwright browser_snapshot when sensitive data may be visible on screen.',
  {},
  async () => {
    try {
      // Collect all secret values from the vault
      const allSecrets = await listSecrets();
      const secretValues = [];
      for (const s of allSecrets) {
        try {
          const value = await getSecretByTitle(s.title);
          if (value) secretValues.push(value);
        } catch { /* skip unresolvable secrets */ }
      }

      const result = await redactedSnapshot(PLAYWRIGHT_URL, secretValues);

      // Extract text content from the result
      const text = result.content?.map(c => c.text).join('\n') || JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Redacted snapshot failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: export_skill ---
server.tool(
  'export_skill',
  `Export a PhantomAuth skill or instructions file into the current project directory so that AI agents can automatically load it. Copies the bundled skill file for the chosen target into the appropriate location relative to the current working directory.`,
  {
    target: z.enum(['copilot', 'claude', 'universal']).describe(
      'The AI agent target to export the skill for. ' +
      '"copilot" → .github/copilot-instructions.md, ' +
      '"claude" → .claude/skills/phantomauth.md, ' +
      '"universal" → SKILL.md'
    ),
  },
  async ({ target }) => {
    try {
      const targets = {
        copilot: {
          src: join(__dirname, '.github', 'copilot-instructions.md'),
          dest: join(process.cwd(), '.github', 'copilot-instructions.md'),
          name: 'GitHub Copilot instructions',
          hint: 'GitHub Copilot will automatically load these instructions for your project.',
        },
        claude: {
          src: join(__dirname, '.claude', 'skills', 'phantomauth.md'),
          dest: join(process.cwd(), '.claude', 'skills', 'phantomauth.md'),
          name: 'Claude Code skill',
          hint: 'Claude Code will automatically discover this skill file.',
        },
        universal: {
          src: join(__dirname, 'SKILL.md'),
          dest: join(process.cwd(), 'SKILL.md'),
          name: 'Universal skill file',
          hint: 'Use with agentskills CLI: npx agentskills export --target <agent>',
        },
      };

      const config = targets[target];

      if (!existsSync(config.src)) {
        return {
          content: [{ type: 'text', text: `❌ Source file not found: ${config.src}` }],
          isError: true,
        };
      }

      const destDir = dirname(config.dest);
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }

      const overwritten = existsSync(config.dest);
      const content = readFileSync(config.src, 'utf-8');
      writeFileSync(config.dest, content, 'utf-8');

      const lines = [`✅ ${config.name} exported to: ${config.dest}`];
      if (overwritten) lines.push('(existing file was overwritten)');
      lines.push(config.hint);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to export skill: ${err.message}` }],
        isError: true,
      };
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
