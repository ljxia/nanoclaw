/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the bin and args to stop a container by name. */
export function stopContainer(name: string): { bin: string; args: string[] } {
  return { bin: CONTAINER_RUNTIME_BIN, args: ['stop', name] };
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** True when running rootless Docker (host UID maps to root inside container). */
let _isRootless: boolean | null = null;
export function isRootlessRuntime(): boolean {
  if (_isRootless !== null) return _isRootless;
  try {
    const info = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['info', '--format', '{{.SecurityOptions}}'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 5000,
      },
    );
    _isRootless = info.includes('rootless');
  } catch {
    _isRootless = false;
  }
  return _isRootless;
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execFileSync(CONTAINER_RUNTIME_BIN, ['stop', name], { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
