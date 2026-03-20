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
const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

function normalizeBase64(input: string): string {
  return input.replace(/\s+/g, '');
}

function normalizePrivateKeyContent(input: string): string {
  const normalized = input.replace(/\r\n/g, '\n').trim();
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function looksLikePrivateKey(input: string): boolean {
  return PRIVATE_KEY_HEADER_PATTERN.test(input);
}

function isStrictBase64(input: string): boolean {
  if (input.length === 0 || input.length % 4 !== 0) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(input);
}

function decodeKeyMaterial(input: string): string {
  if (looksLikePrivateKey(input)) {
    return normalizePrivateKeyContent(input);
  }

  const normalizedBase64 = normalizeBase64(input);
  if (!isStrictBase64(normalizedBase64)) {
    throw new Error(
      'The key input must be a valid base64-encoded private key or a raw PEM/OpenSSH private key.'
    );
  }

  const decodedKey = Buffer.from(normalizedBase64, 'base64');
  if (decodedKey.length === 0) {
    throw new Error('The provided key input could not be decoded.');
  }

  const canonicalBase64 = decodedKey.toString('base64').replace(/=+$/, '');
  const providedBase64 = normalizedBase64.replace(/=+$/, '');
  if (canonicalBase64 !== providedBase64) {
    throw new Error('The provided key input is not valid base64-encoded key material.');
  }

  const decodedKeyString = normalizePrivateKeyContent(decodedKey.toString('utf8'));
  if (!looksLikePrivateKey(decodedKeyString)) {
    throw new Error(
      'The decoded key does not look like a supported PEM/OpenSSH private key. Verify the secret contents.'
    );
  }

  return decodedKeyString;
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
    const keyInput = core.getInput('key', { required: true, trimWhitespace: false });
    const sshUser = assertSingleLineInput('username', core.getInput('username', { required: true }));
    const sshHost = assertSingleLineInput('host', core.getInput('host', { required: true }));
    const sshPort = validatePort(core.getInput('port') || '22');
    const sshIdentityFileName = validateIdentityFileName(core.getInput('key_file_name') || 'key.pem');
    const sshAlias = assertSingleLineInput('alias', core.getInput('alias') || 'ssh-host');

    core.setSecret(keyInput);

    const privateKeyContent = decodeKeyMaterial(keyInput);
    const privateKeyBuffer = Buffer.from(privateKeyContent, 'utf8');
    core.setSecret(privateKeyContent);

    const homeDirectory = os.homedir();
    const sshDirectory = path.join(homeDirectory, '.ssh');
    const identityFilePath = path.join(sshDirectory, sshIdentityFileName);
    const sshConfigPath = path.join(sshDirectory, 'config');
    const markerStart = `# BEGIN SOARA SSH ACTION ${sshAlias}`;
    const markerEnd = `# END SOARA SSH ACTION ${sshAlias}`;

    await fs.mkdir(sshDirectory, { recursive: true, mode: SSH_DIR_MODE });
    await ensureSecurePermissions(sshDirectory, SSH_DIR_MODE);

    await fs.writeFile(identityFilePath, privateKeyBuffer, { mode: SSH_FILE_MODE });
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
