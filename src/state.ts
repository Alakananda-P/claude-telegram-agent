import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface JobRecord {
  id: string; project: string; startedAt: string;
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finishedAt?: string;
}
export interface State {
  version: 1; offset: number; project: string; sessions: Record<string, string>;
  active: JobRecord | null; lastJob: JobRecord | null;
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
