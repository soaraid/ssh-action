import * as core from '@actions/core';
import { promises as fs } from 'node:fs';

const STATE_KEY_PATH = 'sshKeyPath';
const STATE_CONFIG_PATH = 'sshConfigPath';
const STATE_MARKER_START = 'sshConfigMarkerStart';
const STATE_MARKER_END = 'sshConfigMarkerEnd';

function removeManagedBlock(content: string, markerStart: string, markerEnd: string): string {
  const escapedStart = markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  return content.replace(blockPattern, '').trim();
}

async function securelyDeleteFile(filePath: string): Promise<void> {
  try {
    const fileHandle = await fs.open(filePath, 'r+');

    try {
      const stats = await fileHandle.stat();
      if (stats.size > 0) {
        await fileHandle.writeFile(Buffer.alloc(stats.size, 0));
      }
    } finally {
      await fileHandle.close();
    }

    await fs.unlink(filePath);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function cleanupConfig(configPath: string, markerStart: string, markerEnd: string): Promise<void> {
  try {
    const existingConfig = await fs.readFile(configPath, 'utf8');
    const cleanedConfig = removeManagedBlock(existingConfig, markerStart, markerEnd);

    if (cleanedConfig.length === 0) {
      await fs.unlink(configPath);
      return;
    }

    await fs.writeFile(configPath, `${cleanedConfig}\n`, { mode: 0o600 });
    await fs.chmod(configPath, 0o600);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function run(): Promise<void> {
  try {
    const keyPath = core.getState(STATE_KEY_PATH);
    const configPath = core.getState(STATE_CONFIG_PATH);
    const markerStart = core.getState(STATE_MARKER_START);
    const markerEnd = core.getState(STATE_MARKER_END);

    if (keyPath) {
      await securelyDeleteFile(keyPath);
    }

    if (configPath && markerStart && markerEnd) {
      await cleanupConfig(configPath, markerStart, markerEnd);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    core.setFailed(message);
  }
}

void run();
