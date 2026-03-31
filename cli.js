#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

if (command === 'export-skill') {
  const target = args[1];
  
  if (!target) {
    console.error('Usage: phantomauth export-skill <copilot|claude|universal>');
    console.error('');
    console.error('Targets:');
    console.error('  copilot    Copy to .github/copilot-instructions.md');
    console.error('  claude     Copy to .claude/skills/phantomauth.md');
    console.error('  universal  Copy SKILL.md to project root');
    process.exit(1);
  }

  const targets = {
    copilot: {
      src: join(__dirname, '.github', 'copilot-instructions.md'),
      dest: join(process.cwd(), '.github', 'copilot-instructions.md'),
      name: 'GitHub Copilot instructions',
    },
    claude: {
      src: join(__dirname, '.claude', 'skills', 'phantomauth.md'),
      dest: join(process.cwd(), '.claude', 'skills', 'phantomauth.md'),
      name: 'Claude Code skill',
    },
    universal: {
      src: join(__dirname, 'SKILL.md'),
      dest: join(process.cwd(), 'SKILL.md'),
      name: 'Universal skill file',
    },
  };

  const config = targets[target];
  if (!config) {
    console.error(`Unknown target: "${target}". Use: copilot, claude, or universal`);
    process.exit(1);
  }

  if (!existsSync(config.src)) {
    console.error(`Source file not found: ${config.src}`);
    process.exit(1);
  }

  // Check if destination already exists
  if (existsSync(config.dest)) {
    console.warn(`⚠️  ${config.dest} already exists.`);
    console.warn('   Overwriting with PhantomAuth skill file...');
  }

  // Create directory if needed
  const destDir = dirname(config.dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  // Copy the file
  const content = readFileSync(config.src, 'utf-8');
  writeFileSync(config.dest, content, 'utf-8');

  console.log(`✅ ${config.name} exported to: ${config.dest}`);
  console.log('');
  if (target === 'copilot') {
    console.log('GitHub Copilot will automatically load these instructions for your project.');
  } else if (target === 'claude') {
    console.log('Claude Code will automatically discover this skill file.');
  } else {
    console.log('Use with agentskills CLI: npx agentskills export --target <agent>');
  }

} else if (command === '--help' || command === '-h') {
  console.log('PhantomAuth — Secure Browser Authentication for AI Agents');
  console.log('');
  console.log('Usage:');
  console.log('  phantomauth                    Start the MCP server (stdio)');
  console.log('  phantomauth export-skill <t>   Export skill file for an AI agent');
  console.log('');
  console.log('Targets for export-skill:');
  console.log('  copilot    → .github/copilot-instructions.md');
  console.log('  claude     → .claude/skills/phantomauth.md');
  console.log('  universal  → SKILL.md');
  console.log('');
  console.log('When run without arguments, starts the MCP stdio server.');

} else if (command === undefined) {
  // No arguments: start the MCP stdio server.
  await import('./index.js');
} else {
  // Unknown command: report the error on stderr and exit non-zero without writing to stdout.
  console.error(`Unknown command: "${command}"`);
  console.error('');
  console.error('Usage:');
  console.error('  phantomauth                    Start the MCP server (stdio)');
  console.error('  phantomauth export-skill <t>   Export skill file for an AI agent');
  console.error('  phantomauth --help             Show this help message');
  process.exit(1);
}
