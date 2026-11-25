import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validSettings, type AgentSettings } from './settings.js';
import type { Task, Schedule, Upload, Batch } from './automation.js';
import { z } from 'zod';
import { keyRecordSchema, type KeyRecord } from './key-pool.js';
import { backgroundJobSchema, type BackgroundJob } from './background.js';
import { projectRecordSchema, type ProjectRecord } from './project-state.js';
import type { ModelCatalogState } from './models.js';
import type { PricingState } from './pricing.js';
import type { UpdateRecord } from './updater.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const projectId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
const isoDate = z.string().datetime();
const messageContext = z.object({ beforeMessageId: z.number().int().positive().optional(), replyToMessageId: z.number().int().positive().optional() }).optional();
const outage = z.object({ startedAt: isoDate, failures: z.number().int().positive(), reason: z.string().max(64) });
const steerSchema = z.object({ messageContext, id: identifier, text: z.string().min(1).max(30000), displayText: z.string().max(30000), status: z.enum(['preparing', 'sent', 'answered', 'failed']), voiceInput: z.string().regex(/^uploads\/[a-zA-Z0-9._-]+$/).optional(), attachedFiles: z.array(z.string().regex(/^uploads\/[a-zA-Z0-9._-]+$/)).optional(), archived: z.boolean().optional() });
const taskSchema = z.object({ deadlineAt: isoDate.optional(), handoffFrom: identifier.optional(), planMode: z.boolean().optional(), failureKind: z.enum(['safety_refusal', 'timeout', 'owner_cancelled', 'shutdown', 'worker_restart', 'api_failure', 'sdk_error', 'storage_failure', 'transcription_failed']).optional(), messageContext, id: identifier, project: projectId, chatKey: identifier, kind: z.enum(['agent', 'reminder', 'backup']), status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']), prompt: z.string().min(1).max(30000), createdAt: isoDate, settings: z.custom(validSettings).optional(), steers: z.array(steerSchema).optional(), voiceInput: z.string().regex(/^uploads\/[a-zA-Z0-9._-]+$/).optional(), attachedFiles: z.array(z.string().regex(/^uploads\/[a-zA-Z0-9._-]+$/)).optional() });
const automationState = z.object({
  projects: z.array(projectRecordSchema).refine(records => new Set(records.map(p => p.id)).size === records.length).optional(),
  backgroundJobs: z.array(backgroundJobSchema).optional(),
  health: z.object({ telegramOutage: outage.optional(), telegramOutages: z.array(outage.extend({ endedAt: isoDate, durationMs: z.number().finite().nonnegative() })).max(50).optional() }).passthrough().optional(),
  pendingMessageCleanup: z.array(z.object({ chat: z.number().int().positive(), id: z.number().int().positive(), retryAt: z.number().finite().nonnegative().optional(), attempts: z.number().int().nonnegative().optional() })).optional(),
  undeletableMessageIds: z.array(z.number().int().positive()).optional(),
  botMessages: z.array(z.object({ id: z.number().int().positive(), chat: z.number().int().positive(), sentAt: z.number().finite().nonnegative(), preview: z.string().max(1000), kind: z.string().max(32) })).max(2000).optional(),
  transcriptionUsage: z.object({ completedRequests: z.number().int().nonnegative(), seconds: z.number().nonnegative(), cachedRequests: z.number().int().nonnegative(), lastSuccessAt: isoDate.optional() }).optional(),
  keyRecords: z.record(z.string().regex(/^[a-f0-9]{16}$/), keyRecordSchema).optional(),
  uiMessages: z.array(z.object({ id: z.number().int().positive(), chat: z.number().int().positive(), kind: z.enum(['panel', 'notice']), scope: z.string().max(150), createdAt: z.number().finite(), expiresAt: z.number().finite(), retryAt: z.number().finite().optional(), attempts: z.number().int().nonnegative().optional() })).optional(),
  tasks: z.array(taskSchema).optional(),
  schedules: z.array(z.object({ id: identifier, project: projectId, name: z.string().min(1).max(80), prompt: z.string().min(1).max(10000), kind: z.enum(['agent', 'reminder', 'backup']), enabled: z.boolean(), nextRun: isoDate, timezone: z.string(), at: z.string().optional(), cron: z.string().optional(), intervalMinutes: z.number().int().positive().optional() }).refine(s => [s.at, s.cron, s.intervalMinutes].filter(v => v !== undefined).length === 1)).optional(),
  uploads: z.array(z.object({ id: identifier, project: projectId, chatKey: identifier, path: z.string().regex(/^uploads\/[a-zA-Z0-9._-]+$/), name: z.string(), photo: z.boolean(), mediaType: z.enum(['video', 'animation', 'audio', 'voice']).optional(), receivedAt: isoDate, batchId: identifier })).optional(),
  batches: z.array(z.object({ id: identifier, project: projectId, chatKey: identifier, uploadIds: z.array(identifier), status: z.enum(['collecting', 'queued', 'discarded']), updatedAt: isoDate })).optional(),
  bindings: z.record(identifier, identifier).optional(), drafts: z.record(projectId, identifier).optional(), purgedSessions: z.array(identifier).optional(), resumeDisabled: z.array(identifier).optional(),
  freshContexts: z.record(identifier, z.string().max(3000)).optional(),
  queuePaused: z.boolean().optional(), disabledKeyIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).optional(), sessionCredentials: z.record(identifier, z.string().regex(/^[a-f0-9]{16}$/)).optional(),
});

export interface JobRecord {
  id: string; project: string; startedAt: string;
  endReason?: Task['failureKind'];
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finishedAt?: string;
}
export interface Conversation {
  id: string; project: string; updatedAt: string;
  title?: string; titleSource?: 'fallback' | 'auto' | 'model' | 'manual'; titleAttempted?: boolean;
  trashedAt?: string; purgeAt?: string;
}
export interface TelegramOutage { startedAt: string; endedAt: string; durationMs: number; failures: number; reason: string }
export interface State {
  projects?: ProjectRecord[];
  backgroundJobs?: BackgroundJob[];
  pendingMessageCleanup?: { chat: number; id: number; retryAt?: number; attempts?: number }[];
  undeletableMessageIds?: number[];
  botMessages?: { id: number; chat: number; sentAt: number; preview: string; kind: string }[];
  transcriptionUsage?: { completedRequests: number; seconds: number; cachedRequests: number; lastSuccessAt?: string };
  keyRecords?: Record<string, KeyRecord>;
  version: 1; offset: number; project: string; sessions: Record<string, string>;
  active: JobRecord | null; lastJob: JobRecord | null;
  settings?: AgentSettings;
  /** Last good Models API list (new optional field; older versions ignore it). */
  modelCatalog?: ModelCatalogState;
  /** Newest model id per family that the owner was told about (new optional field). */
  modelNotices?: Record<string, string>;
  /** Last good pricing-page copy (new optional field). */
  pricing?: PricingState;
  /** The last /update: what was live before it, for /de_update (new optional field). */
  update?: UpdateRecord;
  /** One line per removed key record (label and reason, never the key; new optional field). */
  removedKeys?: { label: string; removedAt: string; reason: string }[];
  indicatorIds?: number[];
  lastSpeed?: string;
  memoryEnabled?: boolean;
  conversations?: Conversation[];
  visibleMessageIds?: number[];
  uiMessages?: { id: number; chat: number; kind: 'panel' | 'notice'; scope: string; createdAt: number; expiresAt: number; retryAt?: number; attempts?: number }[];
  chatUiResetDone?: boolean;
  upgradeCheck?: { attempted: boolean; passed: boolean; actualSpeed?: string; checkId?: string };
  tasks?: Task[]; schedules?: Schedule[]; uploads?: Upload[]; batches?: Batch[]; queuePaused?: boolean;
  bindings?: Record<string, string>; drafts?: Record<string, string>; purgedSessions?: string[];
  resumeDisabled?: string[]; sessionCredentials?: Record<string, string>; disabledKeyIds?: string[]; activeKeyId?: string;
  freshContexts?: Record<string, string>;
  health?: { telegramAt?: string; claudeAt?: string; apiError?: string; lastAlert?: string; lastBackupAt?: string; activeCredential?: number; disabledCredentials?: number[]; telegramOutage?: Omit<TelegramOutage, 'endedAt' | 'durationMs'>; telegramOutages?: TelegramOutage[] };
}

/** Removes task and steer records that fail validation and returns them for the quarantine file. */
function quarantineInvalidTasks(data: State): { kind: 'task' | 'steer'; taskId?: unknown; record: unknown }[] {
  const removed: { kind: 'task' | 'steer'; taskId?: unknown; record: unknown }[] = [];
  const tasks: unknown = (data as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return removed;
  for (const task of tasks) {
    const steers: unknown = task && typeof task === 'object' ? (task as { steers?: unknown }).steers : undefined;
    if (!Array.isArray(steers)) continue;
    (task as { steers: unknown[] }).steers = steers.filter(steer => steerSchema.safeParse(steer).success || (removed.push({ kind: 'steer', taskId: (task as { id?: unknown }).id, record: steer }), false));
  }
  (data as { tasks?: unknown[] }).tasks = tasks.filter(task => taskSchema.safeParse(task).success || (removed.push({ kind: 'task', record: task }), false));
  return removed;
}

export class StateStore {
  private saving: Promise<void> = Promise.resolve();
  /** Tasks that were running when the previous process died (W47-08); not persisted. */
  interruptedAtStart: string[] = [];
  /** Quarantine file written at startup for invalid task/steer records (H3); not persisted. */
  quarantinedAtStart?: string;
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
    // H3: one bad task or steer record must not stop the whole bot. Move it to a
    // quarantine file next to the state (never executed), then validate the rest.
    let quarantinedAtStart: string | undefined;
    if (!automationState.safeParse(data).success) {
      const removed = quarantineInvalidTasks(data);
      if (removed.length) {
        quarantinedAtStart = `${file}.quarantine-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        await writeFile(quarantinedAtStart, JSON.stringify(removed, null, 2), { mode: 0o600, flag: 'wx' });
      }
      if (!automationState.safeParse(data).success) throw new Error('Cannot load bot state; invalid automation data.');
    }
    for (const key of ['tasks', 'schedules', 'uploads', 'batches', 'purgedSessions'] as const) {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('Cannot load bot state; invalid automation records.');
      data[key] ??= [];
    }
    // A queued handoff may have been staged in the middle of a selection or
    // cancellation transaction. Never replay that uncertain continuation.
    const interrupted: string[] = [];
    for (const task of data.tasks!) if (task.status === 'running' || (task.status === 'queued' && task.handoffFrom)) { if (task.status === 'running') interrupted.push(task.id); task.status = 'interrupted'; task.failureKind = 'worker_restart'; task.finishedAt = new Date().toISOString(); }
    for (const job of data.backgroundJobs ?? []) if (['starting', 'running'].includes(job.status)) { job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); }
    data.bindings = Object.assign(Object.create(null), data.bindings ?? {});
    data.drafts = Object.assign(Object.create(null), data.drafts ?? {});
    data.health ??= {};
    data.conversations ??= [];
    for (const [project, id] of Object.entries(data.sessions)) {
      if (data.purgedSessions!.includes(id)) { delete data.sessions[project]; continue; }
      if (!data.conversations.some(s => s.id === id)) data.conversations.push({ id, project, updatedAt: new Date().toISOString() });
    }
    if (data.active) {
      data.lastJob = { ...data.active, status: 'interrupted', endReason: 'worker_restart', finishedAt: new Date().toISOString() };
      data.active = null;
    }
    const store = new StateStore(file, data);
    store.interruptedAtStart = interrupted;
    store.quarantinedAtStart = quarantinedAtStart;
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
