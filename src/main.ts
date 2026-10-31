import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { StateStore } from './state.js';
import { Telegram, TelegramError } from './telegram.js';
import { Controller } from './controller.js';
import { ClaudeRunner } from './agent.js';
import { poll } from './polling.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv.includes('--check')) {
    console.log(`Configuration valid: ${config.model}, high, auto; private owner configured. No network calls made.`);
    return;
  }
  for (const dir of ['home', 'claude', 'workspaces', 'bot']) await mkdir(path.join(config.dataDir, dir), { recursive: true, mode: 0o700 });
  const store = await StateStore.open(path.join(config.dataDir, 'bot', 'state.json'));
  const telegram = new Telegram(config.token, [config.apiKey]);
  await telegram.call('getMe');
  const webhook = await telegram.call<{ url?: string }>('getWebhookInfo');
  if (webhook.url) throw new Error('This bot already has a webhook. Remove it explicitly or use a dedicated bot before starting polling.');
  const controller = new Controller(config, store, telegram, new ClaudeRunner(config));
  const shutdown = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    const forcedExit = setTimeout(() => process.exit(1), 25_000);
    forcedExit.unref();
    void controller.stop().catch(() => {}).finally(() => clearTimeout(forcedExit));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await telegram.call('setMyCommands', { commands: [
      { command: 'help', description: 'Commands and capabilities' },
      { command: 'status', description: 'Current task and execution limits' },
      { command: 'stop', description: 'Stop current task' },
      { command: 'new', description: 'Fresh conversation, keep files' },
      { command: 'project', description: 'Create or switch project' },
      { command: 'projects', description: 'List projects' },
      { command: 'files', description: 'List project files' },
      { command: 'get', description: 'Download a project file' },
    ], scope: { type: 'chat', chat_id: config.owner } }).catch(() => {});
    await telegram.send(config.owner, `Agent online: Sonnet 5.5 / high / auto. Project: ${store.data.project}.` +
      (store.data.lastJob?.status === 'interrupted' ? '\nA previous task was interrupted. It was NOT replayed. Review files before retrying.' : '')).catch(() => {});
    console.log('Private Telegram worker started.');
    await poll(telegram, store, message => controller.handle(message), shutdown.signal);
  } finally {
    stop();
    await controller.stop();
  }
}

main().catch(error => {
  // Never dump SDK, fetch, or Telegram error objects containing request secrets.
  if (error instanceof TelegramError) console.error(error.message);
  else if (error instanceof Error && /^(Set |Invalid TELEGRAM|CLAUDE_|MAX_|JOB_TIMEOUT|This bot already|Cannot load bot state)/.test(error.message)) console.error(error.message);
  else console.error('Startup/runtime failed. Check configuration, credentials and persistent storage.');
  process.exitCode = 1;
});
