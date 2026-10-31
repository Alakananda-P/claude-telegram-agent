import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig, configSecrets } from './config.js';
import { StateStore } from './state.js';
import { Telegram, TelegramError } from './telegram.js';
import { Controller } from './controller.js';
import { ClaudeRunner } from './agent.js';
import { poll } from './polling.js';
import { UsageLedger } from './usage.js';
import { settingsLabel } from './settings.js';
import { ChatArchive } from './chats.js';
import { HaikuTitles } from './titles.js';
import { ResilientRunner } from './recovery.js';
import { acceptance } from './acceptance.js';
import { Automation } from './automation.js';
import { KeyPool, messageProbe } from './key-pool.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv.includes('--check')) {
    console.log(`Configuration valid: ${settingsLabel(config)}, auto; private owner configured. No network calls made.`);
    return;
  }
  for (const dir of ['home', 'claude', 'workspaces', 'bot']) await mkdir(path.join(config.dataDir, dir), { recursive: true, mode: 0o700 });
  const store = await StateStore.open(path.join(config.dataDir, 'bot', 'state.json'));
  const chats = new ChatArchive(path.join(config.dataDir, 'bot', 'chats'), configSecrets(config));
  const recovered = await chats.importHistory(path.join(config.dataDir, 'claude', 'projects'), [...(store.data.purgedSessions ?? []), ...store.data.conversations!.filter(s => s.trashedAt).map(s => s.id)]);
  for (const chat of recovered) {
    if (!store.data.conversations?.some(x => x.id === chat.id)) (store.data.conversations ??= []).push(chat);
  }
  await store.save();
  const ledger = await UsageLedger.open(path.join(config.dataDir, 'bot', 'usage.jsonl'));
  await ledger.importHistory(path.join(config.dataDir, 'claude', 'projects'));
  const totals = ledger.totals();
  console.log(`Usage ledger ready: sessions=${totals.sessions}; partial=${totals.partial}.`);
  const telegram = new Telegram(config.token, configSecrets(config));
  telegram.timeline = store;
  await telegram.call('getMe');
  const webhook = await telegram.call<{ url?: string }>('getWebhookInfo');
  if (webhook.url) throw new Error('This bot already has a webhook. Remove it explicitly or use a dedicated bot before starting polling.');
  const keys = new KeyPool(config, store, messageProbe(ledger));
  await keys.initialize();
  console.log(`API key pool ready: configured=${keys.list().length}; automaticChecks=true.`);
  const controller = new Controller(config, store, telegram, new ResilientRunner(config, store, undefined, undefined, keys), ledger, new HaikuTitles(config, ledger, undefined, () => keys.selectedConfig()), keys);
  const shutdown = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    void keys.stop().catch(() => {});
    const forcedExit = setTimeout(() => process.exit(1), 25_000);
    forcedExit.unref();
    void controller.stop().catch(() => {}).finally(() => clearTimeout(forcedExit));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await controller.prepareSessions(shutdown.signal);
    const checkId = process.env.VERIFY_AGENT_CHECK_ID ?? 'initial-upgrade';
    if (process.env.VERIFY_AGENT_ON_UPGRADE === 'true'
      && (!store.data.upgradeCheck?.attempted || (store.data.upgradeCheck.checkId ?? 'initial-upgrade') !== checkId)) {
      // Explicit rollout acceptance check; one short request, once per data disk.
      // Count its usage in the same ledger and never poll Telegram twice.
      store.data.upgradeCheck = { attempted: true, passed: false, checkId };
      await store.save();
      const probe = new AbortController();
      const timer = setTimeout(() => probe.abort(), 90_000);
      const dir = path.join(config.dataDir, 'bot', 'verification');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const calledTools = new Set<string>();
      try {
        await acceptance();
        if (config.backupEncryptionKey) await controller.exportBackup();
        const checks = await StateStore.open(path.join(dir, 'state.json'));
        await new ClaudeRunner({ ...config, maxTurns: 5 }).run({
          prompt: 'Deployment verification: call mcp__workspace__clock once, then mcp__workspace__validate_bill with one synthetic item: quantity 2, rate 10, amount 20, total 20, no uncertainty. Reply with the single word READY. Do not use other tools or read/change files.',
          cwd: dir, memoryEnabled: false,
          workspace: { root: dir, project: 'default', automation: new Automation(checks), deliver: async () => { throw new Error('Delivery is disabled for this probe.'); }, backup: async () => { throw new Error('Backup is disabled for this probe.'); } },
        }, async event => {
          if (event.type === 'effect' && event.tool) calledTools.add(event.tool);
          if (event.type === 'usage') await ledger.recordResult(event.session, event.id, event.models, event.cost);
          if (event.type === 'step') {
            await ledger.recordStep(event.session, event.id, event.model, event.usage, event.complete);
            if (typeof event.usage.speed === 'string') store.data.upgradeCheck!.actualSpeed = event.usage.speed;
          }
          if (event.type === 'speed') store.data.lastSpeed = event.state;
        }, probe);
        store.data.upgradeCheck.passed = store.data.upgradeCheck.actualSpeed === 'fast' && calledTools.has('mcp__workspace__clock') && calledTools.has('mcp__workspace__validate_bill');
      } catch { console.warn('Upgrade model check did not complete; inspect /status before a larger task.'); }
      finally { clearTimeout(timer); await store.save(); }
      console.log(`Upgrade model check: passed=${store.data.upgradeCheck.passed}; model=${config.model}; effort=${config.effort}; actualSpeed=${store.data.upgradeCheck.actualSpeed ?? 'unconfirmed'}.`);
      console.log(`Upgrade workspace tools: clock=${calledTools.has('mcp__workspace__clock')}; billValidation=${calledTools.has('mcp__workspace__validate_bill')}.`);
    }
    await telegram.call('setMyCommands', { commands: [
      { command: 'help', description: 'Commands and capabilities' },
      { command: 'menu', description: 'Open control panel' },
      { command: 'model', description: 'Choose Fable, Opus or Sonnet' },
      { command: 'efforts', description: 'Choose reasoning effort' },
      { command: 'fast', description: 'Opus Fast mode on or off' },
      { command: 'session', description: 'Saved chats and resume' },
      { command: 'rename', description: 'Rename the current chat' },
      { command: 'memory', description: 'Shared long-term memory' },
      { command: 'token', description: 'Lifetime tokens by model' },
      { command: 'cost', description: 'Lifetime estimated Claude cost' },
      { command: 'status', description: 'Current task and execution limits' },
      { command: 'stop', description: 'Stop current task' },
      { command: 'new', description: 'Fresh conversation, keep files' },
      { command: 'project', description: 'Create or switch project' },
      { command: 'projects', description: 'List projects' },
      { command: 'files', description: 'List project files' },
      { command: 'get', description: 'Download a project file' },
      { command: 'batch', description: 'Collect photos and files in a batch' },
      { command: 'process', description: 'Process waiting photos and files' },
      { command: 'queue', description: 'Tasks, priority, pause and retry' },
      { command: 'schedules', description: 'Reminders and recurring tasks' },
      { command: 'clock', description: 'Current India time' },
      { command: 'trash', description: 'Restore deleted chats within 48 hours' },
      { command: 'backup', description: 'Encrypted export and restore' },
      { command: 'health', description: 'API, Telegram, disk and queue health' },
      { command: 'keys', description: 'API key status and recovery history' },
    ], scope: { type: 'chat', chat_id: config.owner } }).catch(() => {});
    await telegram.call('setChatMenuButton', { chat_id: config.owner, menu_button: { type: 'commands' } }).catch(() => {});
    await controller.cleanIndicators();
    if (process.env.RESET_CHAT_ON_UPGRADE === 'true' && !store.data.chatUiResetDone) {
      const cleared = await telegram.clear(config.owner, true);
      delete store.data.sessions[store.data.project];
      store.data.chatUiResetDone = true;
      await store.save();
      console.log(`Telegram upgrade reset: cleared=${cleared}; recoveredChats=${recovered.length}.`);
      if (!cleared) await telegram.send(config.owner, 'Your new chat is ready. Telegram could not remove some older messages. Saved chats are in Sessions.');
    }
    await controller.menu();
    if (store.data.lastJob?.status === 'interrupted') await telegram.send(config.owner, 'The previous task was interrupted by a restart. Review its files before retrying.').catch(() => {});
    console.log('Private Telegram worker started.');
    controller.start();
    keys.start();
    await poll(telegram, store, message => controller.handle(message), shutdown.signal, callback => controller.callback(callback), async failures => {
      if (failures >= 3) await telegram.send(config.owner, 'Telegram connection recovered. Queued work and stored files are preserved. Check /health for the latest status.').catch(() => {});
    });
  } finally {
    stop();
    await controller.stop();
    await keys.stop();
  }
}

main().catch(error => {
  // Never dump SDK, fetch, or Telegram error objects containing request secrets.
  if (error instanceof TelegramError) console.error(`${error.message} Network: ${error.networkCode ?? 'none'}.`);
  else if (error instanceof Error && /^(Set |Invalid TELEGRAM|CLAUDE_|MAX_|JOB_TIMEOUT|This bot already|Cannot load bot state)/.test(error.message)) console.error(error.message);
  else console.error('Startup/runtime failed. Check configuration, credentials and persistent storage.');
  process.exitCode = 1;
});
