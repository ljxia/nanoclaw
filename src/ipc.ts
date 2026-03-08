import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  SERVICES_CONFIG_PATH,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
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
    // For restart_service
    service?: string;
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

    case 'deploy_service':
    case 'restart_service': {
      const service = data.service as string | undefined;
      if (!service) {
        logger.warn({ sourceGroup }, `${data.type} missing service name`);
        break;
      }
      const services = loadServiceRegistry();
      const svc = services[service];
      if (!svc) {
        logger.warn(
          { service, sourceGroup },
          'Unknown service in restart request',
        );
        // Send feedback to the group
        const chatJid = findChatJidByFolder(sourceGroup, registeredGroups);
        if (chatJid) {
          await deps.sendMessage(
            chatJid,
            `Unknown service "${service}". Available: ${Object.keys(services).join(', ') || 'none'}`,
          );
        }
        break;
      }
      const isRestart = data.type === 'restart_service';
      const cmd =
        isRestart && svc.restartCommand ? svc.restartCommand : svc.command;
      const action = isRestart ? 'Restarting' : 'Deploying';
      const dir = expandHomePath(svc.directory);
      logger.info(
        { service, directory: dir, sourceGroup, action: data.type, cmd },
        `${action} service`,
      );
      exec(
        cmd,
        { cwd: dir, timeout: 300_000, maxBuffer: 5 * 1024 * 1024 },
        async (err, stdout, stderr) => {
          const verb = isRestart ? 'restart' : 'deploy';
          let msg: string;
          if (err) {
            const combined = [stdout, stderr].filter(Boolean).join('\n');
            const clean = combined.replace(
              /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[[0-9;]*m/g,
              '',
            );
            const detail = (clean || err.message).slice(-4000);
            msg = `Failed to ${verb} ${service}:\n${detail}`;
          } else {
            msg = `${isRestart ? 'Restarted' : 'Deployed'} ${service} successfully.`;
          }
          writeIpcInput(sourceGroup, msg);
        },
      );
      break;
    }

    case 'test_service': {
      const service = data.service as string | undefined;
      if (!service) {
        logger.warn({ sourceGroup }, 'test_service missing service name');
        break;
      }
      const testServices = loadServiceRegistry();
      const testSvc = testServices[service];
      if (!testSvc?.testCommand) {
        const chatJid = findChatJidByFolder(sourceGroup, registeredGroups);
        if (chatJid) {
          const reason = !testSvc
            ? `Unknown service "${service}". Available: ${Object.keys(testServices).join(', ') || 'none'}`
            : `No testCommand configured for "${service}".`;
          await deps.sendMessage(chatJid, reason);
        }
        break;
      }
      const testDir = expandHomePath(testSvc.directory);
      logger.info(
        { service, directory: testDir, sourceGroup, cmd: testSvc.testCommand },
        'Testing service',
      );
      exec(
        testSvc.testCommand,
        { cwd: testDir, timeout: 300_000, maxBuffer: 5 * 1024 * 1024 },
        async (err, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join('\n');
          // Strip ANSI escape codes for readability
          const clean = combined.replace(
            /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[[0-9;]*m/g,
            '',
          );
          const output = clean.slice(-4000);
          const msg = err
            ? `Tests failed for ${service}:\n${output}`
            : `Tests passed for ${service}:\n${output}`;
          writeIpcInput(sourceGroup, msg);
        },
      );
      break;
    }

    // -- Wallet operations --------------------------------------------------

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

function expandHomePath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

interface ServiceConfig {
  directory: string;
  command: string;
  restartCommand?: string;
  testCommand?: string;
}

function loadServiceRegistry(): Record<string, ServiceConfig> {
  try {
    if (!fs.existsSync(SERVICES_CONFIG_PATH)) {
      logger.debug({ path: SERVICES_CONFIG_PATH }, 'Services config not found');
      return {};
    }
    return JSON.parse(fs.readFileSync(SERVICES_CONFIG_PATH, 'utf-8'));
  } catch (err) {
    logger.error(
      { err, path: SERVICES_CONFIG_PATH },
      'Failed to load services config',
    );
    return {};
  }
}

function findChatJidByFolder(
  folder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder) return jid;
  }
  return null;
}
