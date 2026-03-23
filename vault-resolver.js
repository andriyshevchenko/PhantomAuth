import keytar from 'keytar';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SERVICE_NAME = 'SecureVault';

function getConfigDir() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SecureVault');
  } else if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'SecureVault');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'securevault');
}

async function loadJson(filename) {
  try {
    const filePath = join(getConfigDir(), filename);
    const data = await readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function getSecretByTitle(title) {
  const metadata = await loadJson('metadata.json');
  const entry = metadata.find(s => s.title === title);
  if (!entry) {
    throw new Error(`Secret not found: "${title}". Available secrets: ${metadata.map(s => s.title).join(', ')}`);
  }
  const value = await keytar.getPassword(SERVICE_NAME, entry.id);
  if (value === null) {
    throw new Error(`Secret "${title}" exists in metadata but has no value in the OS keychain`);
  }
  return value;
}

export async function getSecretById(id) {
  const value = await keytar.getPassword(SERVICE_NAME, id);
  if (value === null) {
    throw new Error(`No secret found in keychain for id: ${id}`);
  }
  return value;
}

export async function resolveProfile(profileName) {
  const profiles = await loadJson('profiles.json');
  const profile = profiles.find(p => p.name === profileName);
  if (!profile) {
    throw new Error(`Profile not found: "${profileName}". Available profiles: ${profiles.map(p => p.name).join(', ')}`);
  }

  const metadata = await loadJson('metadata.json');
  const resolved = {};

  for (const mapping of profile.mappings) {
    const secret = await keytar.getPassword(SERVICE_NAME, mapping.secretId);
    const meta = metadata.find(m => m.id === mapping.secretId);
    const label = meta?.title || mapping.secretId;
    if (secret !== null) {
      resolved[mapping.envVar] = { value: secret, label };
    }
  }

  return resolved;
}

export async function listSecrets() {
  const metadata = await loadJson('metadata.json');
  return metadata.map(s => ({ title: s.title, category: s.category }));
}

export async function listProfiles() {
  const profiles = await loadJson('profiles.json');
  const metadata = await loadJson('metadata.json');
  return profiles.map(p => ({
    name: p.name,
    mappings: p.mappings.map(m => {
      const meta = metadata.find(s => s.id === m.secretId);
      return { envVar: m.envVar, secretTitle: meta?.title || '(unknown)' };
    })
  }));
}
