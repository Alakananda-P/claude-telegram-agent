import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validSettings, type AgentSettings } from './settings.js';

export interface JobRecord {
  id: string; project: string; startedAt: string;
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finishedAt?: string;
}
export interface Conversation {
  id: string; project: string; updatedAt: string;
  title?: string; titleSource?: 'fallback' | 'auto' | 'model' | 'manual'; titleAttempted?: boolean;
}
export interface State {
  version: 1; offset: number; project: string; sessions: Record<string, string>;
  active: JobRecord | null; lastJob: JobRecord | null;
  settings?: AgentSettings;
  indicatorIds?: number[];
  lastSpeed?: string;
  memoryEnabled?: boolean;
  conversations?: Conversation[];
  visibleMessageIds?: number[];
  chatUiResetDone?: boolean;
  upgradeCheck?: { attempted: boolean; passed: boolean; actualSpeed?: string; checkId?: string };
}

export class StateStore {
  private saving: Promise<void> = Promise.resolve();
  private constructor(readonly file: string, public data: State) {}

  static async open(file: string): Promise<StateStore> {
    let data: State = { version: 1, offset: 0, project: 'default', sessions: {},
      active: null, lastJob: null };
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Number.isSafeInteger(data.offset) || data.offset < 0
        || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(data.project)
        || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)
        || !Object.values(data.sessions).every(v => typeof v === 'string')
        || (data.settings !== undefined && !validSettings(data.settings))
        || (data.memoryEnabled !== undefined && typeof data.memoryEnabled !== 'boolean')
        || (data.conversations !== undefined && (!Array.isArray(data.conversations) || !data.conversations.every(s => s && typeof s.id === 'string' && typeof s.project === 'string' && typeof s.updatedAt === 'string'
          && (s.title === undefined || (typeof s.title === 'string' && s.title.length <= 96))
          && (s.titleSource === undefined || ['fallback', 'auto', 'model', 'manual'].includes(s.titleSource))
          && (s.titleAttempted === undefined || typeof s.titleAttempted === 'boolean'))))
        || (data.indicatorIds !== undefined && (!Array.isArray(data.indicatorIds) || !data.indicatorIds.every(Number.isSafeInteger)))
        || (data.visibleMessageIds !== undefined && (!Array.isArray(data.visibleMessageIds) || !data.visibleMessageIds.every(Number.isSafeInteger)))
        || (data.active !== null && (!data.active || typeof data.active.id !== 'string'))) {
        throw new Error('Invalid state');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load bot state; inspect or restore the state backup before starting.');
    }
    // Older installations may contain retired budget accounting. Preserve work,
    // sessions and update offsets, but discard those obsolete fields.
    Reflect.deleteProperty(data, 'daily');
    for (const job of [data.active, data.lastJob]) {
      if (job && typeof job === 'object') Reflect.deleteProperty(job, 'reserved');
    }
    // Project names are dictionary keys, never Object.prototype lookups.
    data.sessions = Object.assign(Object.create(null), data.sessions);
    data.memoryEnabled ??= true;
    data.conversations ??= [];
    for (const [project, id] of Object.entries(data.sessions)) {
      if (!data.conversations.some(s => s.id === id)) data.conversations.push({ id, project, updatedAt: new Date().toISOString() });
    }
    if (data.active) {
      data.lastJob = { ...data.active, status: 'interrupted', finishedAt: new Date().toISOString() };
      data.active = null;
    }
    const store = new StateStore(file, data);
    await store.save();
    return store;
  }

  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    const task = this.saving.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.saving = task.catch(() => {});
    return task;
  }
}
