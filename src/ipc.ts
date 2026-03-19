import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateMount } from './mount-security.js';
import { AdditionalMount, RegisteredGroup } from './types.js';
import { WalletService } from './wallet-service.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  walletService?: WalletService;
  requestWalletApproval?: (
    details: Record<string, unknown>,
  ) => Promise<boolean>;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For host_exec
    command?: string;
    cwd?: string;
    timeout?: number;
    requestId?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'host_exec': {
      const command = data.command as string | undefined;
      const cwd = data.cwd as string | undefined;
      const requestId = data.requestId as string | undefined;
      const DEFAULT_TIMEOUT = 600_000; // 10 min
      const DEFAULT_MAX_OUTPUT = 200 * 1024; // 200KB per stream

      if (!command || !cwd || !requestId) {
        logger.warn(
          { sourceGroup },
          'host_exec missing required fields (command, cwd, requestId)',
        );
        if (requestId) {
          writeIpcInput(
            sourceGroup,
            `exec_result:${JSON.stringify({ requestId, exitCode: 1, stdout: '', stderr: 'Missing required fields: command, cwd, requestId', durationMs: 0 })}`,
          );
        }
        break;
      }

      const resolved = resolveHostExecPath(cwd, sourceGroup, registeredGroups);
      if (!resolved) {
        logger.warn(
          { sourceGroup, cwd },
          'host_exec rejected: cwd not in allowed mounts',
        );
        writeIpcInput(
          sourceGroup,
          `exec_result:${JSON.stringify({ requestId, exitCode: 1, stdout: '', stderr: `Rejected: "${cwd}" is not a mounted directory for this group, or mount validation failed.`, durationMs: 0 })}`,
        );
        break;
      }

      if (resolved.readonly) {
        logger.warn(
          { sourceGroup, cwd, hostPath: resolved.hostPath },
          'host_exec rejected: mount is read-only',
        );
        writeIpcInput(
          sourceGroup,
          `exec_result:${JSON.stringify({ requestId, exitCode: 1, stdout: '', stderr: `Rejected: "${cwd}" is mounted read-only. host_exec requires a writable mount.`, durationMs: 0 })}`,
        );
        break;
      }

      const timeout = (data.timeout as number | undefined) || resolved.execTimeout || DEFAULT_TIMEOUT;
      const maxOutput = resolved.execMaxOutput || DEFAULT_MAX_OUTPUT;
      const stripAnsi = (s: string) =>
        s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[[0-9;]*m/g, '');

      logger.info(
        { sourceGroup, cwd: resolved.hostPath, command, requestId },
        'Executing host_exec',
      );

      const startTime = Date.now();
      exec(
        command,
        {
          cwd: resolved.hostPath,
          timeout,
          shell: '/bin/sh',
          maxBuffer: 10 * 1024 * 1024,
        },
        (_err, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const exitCode = _err ? ((_err as { code?: number }).code ?? 1) : 0;
          const cleanStdout = stripAnsi(stdout || '').slice(-maxOutput);
          const cleanStderr = stripAnsi(stderr || '').slice(-maxOutput);

          writeIpcInput(
            sourceGroup,
            `exec_result:${JSON.stringify({ requestId, exitCode, stdout: cleanStdout, stderr: cleanStderr, durationMs })}`,
          );
        },
      );
      break;
    }

    // -- Wallet operations --------------------------------------------------

    case 'wallet_create': {
      if (!isMain) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Only main group can create wallets"}',
        );
        break;
      }
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const d = data as Record<string, unknown>;
      const name = d.walletName as string;
      const chains = d.chains as string[] | undefined;
      const result = ws.createWallet(name, chains);
      writeIpcInput(
        sourceGroup,
        `wallet_result:${JSON.stringify({ requestId: d.requestId, ...result })}`,
      );
      break;
    }

    case 'wallet_get_address': {
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const wName =
        ((data as Record<string, unknown>).walletName as string) || 'main';
      const addr = ws.getAddress(wName);
      const chains = ws.getSupportedChains(wName);
      writeIpcInput(
        sourceGroup,
        `wallet_result:${JSON.stringify({
          requestId: (data as Record<string, unknown>).requestId,
          address: addr,
          chains,
          wallets: ws.getWalletNames(),
        })}`,
      );
      break;
    }

    case 'wallet_get_balance': {
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const wName =
        ((data as Record<string, unknown>).walletName as string) || 'main';
      const chain = (data as Record<string, unknown>).chain as string;
      const token = (data as Record<string, unknown>).token as
        | string
        | undefined;
      try {
        const result = await ws.getBalance(wName, chain, token);
        writeIpcInput(
          sourceGroup,
          `wallet_result:${JSON.stringify({
            requestId: (data as Record<string, unknown>).requestId,
            ...result,
          })}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeIpcInput(
          sourceGroup,
          `wallet_result:${JSON.stringify({
            requestId: (data as Record<string, unknown>).requestId,
            error: msg,
          })}`,
        );
      }
      break;
    }

    case 'wallet_estimate_gas': {
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const d = data as Record<string, unknown>;
      try {
        const result = await ws.estimateGas(
          d.chain as string,
          d.to as string,
          d.value as string,
          d.token as string | undefined,
        );
        writeIpcInput(
          sourceGroup,
          `wallet_result:${JSON.stringify({ requestId: d.requestId, ...result })}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeIpcInput(
          sourceGroup,
          `wallet_result:${JSON.stringify({ requestId: d.requestId, error: msg })}`,
        );
      }
      break;
    }

    case 'wallet_send_transaction': {
      if (!isMain) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Only main group can send transactions"}',
        );
        break;
      }
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const d = data as Record<string, unknown>;
      const reqId = d.requestId as string;

      // Request human approval via Discord/terminal
      const approvalDetails = {
        type: 'wallet_send_transaction',
        wallet: d.walletName || 'main',
        chain: d.chain,
        to: d.to,
        value: d.value,
        token: d.token || null,
        memo: d.memo || null,
        requestedBy: sourceGroup,
      };

      let approved = false;
      if (deps.requestWalletApproval) {
        approved = await deps.requestWalletApproval(approvalDetails);
      }

      if (!approved) {
        writeIpcInput(
          sourceGroup,
          `wallet_result:${JSON.stringify({ requestId: reqId, error: 'Transaction denied by user' })}`,
        );
        break;
      }

      const result = await ws.sendTransaction({
        walletName: (d.walletName as string) || 'main',
        chain: d.chain as string,
        to: d.to as string,
        value: d.value as string,
        token: d.token as string | undefined,
        memo: d.memo as string | undefined,
        requestId: reqId,
        sourceGroup,
      });

      writeIpcInput(
        sourceGroup,
        `wallet_result:${JSON.stringify({ requestId: reqId, ...result })}`,
      );
      break;
    }

    case 'wallet_sign_message': {
      if (!isMain) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Only main group can sign messages"}',
        );
        break;
      }
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const d = data as Record<string, unknown>;
      const reqId = d.requestId as string;

      // Request human approval
      const approvalDetails = {
        type: 'wallet_sign_message',
        wallet: d.walletName || 'main',
        message: (d.message as string)?.slice(0, 500),
        memo: d.memo || null,
        requestedBy: sourceGroup,
      };

      let approved = false;
      if (deps.requestWalletApproval) {
        approved = await deps.requestWalletApproval(approvalDetails);
      }

      if (!approved) {
        writeIpcInput(
          sourceGroup,
          `wallet_result:${JSON.stringify({ requestId: reqId, error: 'Signing denied by user' })}`,
        );
        break;
      }

      const result = await ws.signMessage({
        walletName: (d.walletName as string) || 'main',
        message: d.message as string,
        memo: d.memo as string | undefined,
        requestId: reqId,
        sourceGroup,
      });

      writeIpcInput(
        sourceGroup,
        `wallet_result:${JSON.stringify({ requestId: reqId, ...result })}`,
      );
      break;
    }

    case 'wallet_tx_history': {
      const ws = deps.walletService;
      if (!ws) {
        writeIpcInput(
          sourceGroup,
          'wallet_result:{"error":"Wallet service not configured"}',
        );
        break;
      }
      const log = isMain
        ? ws.getTransactionLog()
        : ws.getTransactionLog(sourceGroup);
      writeIpcInput(
        sourceGroup,
        `wallet_result:${JSON.stringify({
          requestId: (data as Record<string, unknown>).requestId,
          transactions: log.slice(-50),
        })}`,
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/** Send a message back to the agent via IPC input (not to the user). */
function writeIpcInput(groupFolder: string, text: string): void {
  const inputDir = path.join(resolveGroupIpcPath(groupFolder), 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to write IPC input');
  }
}

/**
 * Resolve a container-visible path (e.g. /workspace/extra/rolypoly) to the
 * corresponding host path by looking up the requesting group's additionalMounts.
 * Re-validates the mount against the allowlist to ensure it's still permitted.
 */
function resolveHostExecPath(
  containerCwd: string,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): { hostPath: string; readonly: boolean; execTimeout?: number; execMaxOutput?: number } | null {
  // Find the group entry by folder
  let group: RegisteredGroup | undefined;
  let groupIsMain = false;
  for (const g of Object.values(registeredGroups)) {
    if (g.folder === sourceGroup) {
      group = g;
      groupIsMain = g.isMain === true;
      break;
    }
  }
  if (!group) return null;

  const mounts = group.containerConfig?.additionalMounts;
  if (!mounts || mounts.length === 0) return null;

  // Iterate mounts and find one whose container path matches the requested cwd.
  // Container paths are at /workspace/extra/{containerPath|basename(hostPath)}.
  for (const mount of mounts) {
    const containerPath = mount.containerPath || path.basename(mount.hostPath);
    const fullContainerPath = `/workspace/extra/${containerPath}`;

    // Check if the requested cwd matches or is under this mount
    if (
      containerCwd !== fullContainerPath &&
      !containerCwd.startsWith(fullContainerPath + '/')
    ) {
      continue;
    }

    // Re-validate via mount-security to ensure allowlist still permits it
    const validation = validateMount(mount as AdditionalMount, groupIsMain);
    if (!validation.allowed || !validation.realHostPath) {
      logger.warn(
        { sourceGroup, mount: mount.hostPath, reason: validation.reason },
        'host_exec mount re-validation failed',
      );
      return null;
    }

    // If cwd is a subdirectory of the mount, append the relative portion
    let hostPath = validation.realHostPath;
    if (containerCwd !== fullContainerPath) {
      const relative = containerCwd.slice(fullContainerPath.length + 1);
      hostPath = path.join(hostPath, relative);
    }

    return {
      hostPath,
      readonly: validation.effectiveReadonly === true,
      execTimeout: mount.execTimeout,
      execMaxOutput: mount.execMaxOutput,
    };
  }

  return null;
}
