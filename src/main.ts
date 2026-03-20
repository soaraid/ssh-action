import * as core from '@actions/core';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SSH_DIR_MODE = 0o700;
const SSH_FILE_MODE = 0o600;
const STATE_KEY_PATH = 'sshKeyPath';
const STATE_CONFIG_PATH = 'sshConfigPath';
const STATE_MARKER_START = 'sshConfigMarkerStart';
const STATE_MARKER_END = 'sshConfigMarkerEnd';

function normalizeBase64(input: string): string {
  return input.replace(/\s+/g, '');
}

function formatIdentityPathForSshConfig(filePath: string): string {
  return `"${filePath.replace(/\\/g, '/')}"`;
}

function assertSingleLineInput(name: string, value: string): string {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw new Error(`The ${name} input must not be empty.`);
  }

  if (/[\r\n]/.test(trimmedValue)) {
    throw new Error(`The ${name} input must be a single-line value.`);
  }

  return trimmedValue;
}

function validateIdentityFileName(fileName: string): string {
  const normalizedFileName = assertSingleLineInput('key_file_name', fileName);

  if (path.basename(normalizedFileName) !== normalizedFileName) {
    throw new Error('The key_file_name input must be a file name only.');
  }

  if (normalizedFileName === '.' || normalizedFileName === '..') {
    throw new Error('The key_file_name input is invalid.');
  }

  return normalizedFileName;
}

function validatePort(portValue: string): string {
  const normalizedPort = assertSingleLineInput('port', portValue);

  if (!/^\d+$/.test(normalizedPort)) {
    throw new Error('The port input must be a numeric port value.');
  }

  const portNumber = Number(normalizedPort);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error('The port input must be between 1 and 65535.');
  }

  return normalizedPort;
}

function removeManagedBlock(content: string, markerStart: string, markerEnd: string): string {
  const escapedStart = markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  return content.replace(blockPattern, '').trimEnd();
}

async function ensureSecurePermissions(targetPath: string, mode: number): Promise<void> {
  await fs.chmod(targetPath, mode);
}

async function run(): Promise<void> {
  try {
    const keyBase64 = core.getInput('key', { required: true });
    const sshUser = assertSingleLineInput('username', core.getInput('username', { required: true }));
    const sshHost = assertSingleLineInput('host', core.getInput('host', { required: true }));
    const sshPort = validatePort(core.getInput('port') || '22');
    const sshIdentityFileName = validateIdentityFileName(core.getInput('key_file_name') || 'key.pem');
    const sshAlias = assertSingleLineInput('alias', core.getInput('alias') || 'ssh-host');

    core.setSecret(keyBase64);

    const normalizedKeyBase64 = normalizeBase64(keyBase64);
    const decodedKey = Buffer.from(normalizedKeyBase64, 'base64');

    if (decodedKey.length === 0) {
      throw new Error('The provided key input could not be decoded.');
    }

    const decodedKeyString = decodedKey.toString('utf8');
    core.setSecret(decodedKeyString);

    const homeDirectory = os.homedir();
    const sshDirectory = path.join(homeDirectory, '.ssh');
    const identityFilePath = path.join(sshDirectory, sshIdentityFileName);
    const sshConfigPath = path.join(sshDirectory, 'config');
    const markerStart = `# BEGIN SOARA SSH ACTION ${sshAlias}`;
    const markerEnd = `# END SOARA SSH ACTION ${sshAlias}`;

    await fs.mkdir(sshDirectory, { recursive: true, mode: SSH_DIR_MODE });
    await ensureSecurePermissions(sshDirectory, SSH_DIR_MODE);

    await fs.writeFile(identityFilePath, decodedKey, { mode: SSH_FILE_MODE });
    await ensureSecurePermissions(identityFilePath, SSH_FILE_MODE);

    let existingConfig = '';

    try {
      existingConfig = await fs.readFile(sshConfigPath, 'utf8');
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw error;
      }
    }

    const sanitizedConfig = removeManagedBlock(existingConfig, markerStart, markerEnd);
    const configEntries = [
      markerStart,
      `Host ${sshAlias}`,
      `  HostName ${sshHost}`,
      `  User ${sshUser}`,
      `  Port ${sshPort}`,
      `  IdentityFile ${formatIdentityPathForSshConfig(identityFilePath)}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking no',
      '  LogLevel ERROR',
      markerEnd
    ];
    const managedBlock = `${configEntries.join('\n')}\n`;
    const nextConfig = sanitizedConfig.length > 0 ? `${sanitizedConfig}\n\n${managedBlock}` : managedBlock;

    await fs.writeFile(sshConfigPath, nextConfig, { mode: SSH_FILE_MODE });
    await ensureSecurePermissions(sshConfigPath, SSH_FILE_MODE);

    core.saveState(STATE_KEY_PATH, identityFilePath);
    core.saveState(STATE_CONFIG_PATH, sshConfigPath);
    core.saveState(STATE_MARKER_START, markerStart);
    core.saveState(STATE_MARKER_END, markerEnd);

    core.info(`SSH configuration created for alias "${sshAlias}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    core.setFailed(message);
  }
}

void run();
