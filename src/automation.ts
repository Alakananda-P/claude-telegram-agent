import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { StateStore } from './state.js';
import type { AgentSettings } from './settings.js';
import { projectName } from './safety.js';

export interface Task {
  id: string; kind: 'agent' | 'reminder' | 'backup'; project: string; chatKey: string; prompt: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; startedAt?: string; finishedAt?: string; scheduleId?: string; occurrence?: string;
  interactive?: boolean; settings?: AgentSettings; displayPrompt?: string;
}
export interface Schedule {
  id: string; name: string; kind: Task['kind']; prompt: string; project: string; timezone: string;
  at?: string; cron?: string; intervalMinutes?: number; nextRun: string; enabled: boolean;
  lastRun?: string; lastStatus?: Task['status'];
}
export interface ScheduleInput { name: string; kind: Task['kind']; prompt: string; project: string; timezone?: string; at?: string; cron?: string; intervalMinutes?: number }
export interface Upload { id: string; project: string; chatKey: string; path: string; name: string; photo: boolean; receivedAt: string; batchId: string }
export interface Batch { id: string; project: string; chatKey: string; uploadIds: string[]; prompt?: string; groupId?: string; manual?: boolean; status: 'collecting' | 'queued' | 'discarded'; updatedAt: string }

export function clockInfo(timezone = 'Asia/Kolkata', now = new Date()) {
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(now);
  return { utc: now.toISOString(), timezone, local };
}
function next(s: Pick<Schedule, 'cron' | 'intervalMinutes' | 'at' | 'timezone'>, now: Date): string {
  clockInfo(s.timezone, now);
  if (s.cron) return CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: now }).next().toISOString()!;
  if (s.intervalMinutes) return new Date(+now + s.intervalMinutes * 60000).toISOString();
  if (!s.at || !/(Z|[+-]\d\d:\d\d)$/.test(s.at) || !Number.isFinite(Date.parse(s.at))) throw new Error('Use an ISO date/time with its UTC offset.');
  return new Date(s.at).toISOString();
}
export class Automation {
  constructor(readonly store: StateStore) { store.data.tasks ??= []; store.data.schedules ??= []; }
  private insert(input: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    projectName(input.project);
    if (!input.prompt.trim() || input.prompt.length > 30000) throw new Error('Task must contain 1-30000 characters.');
    if (input.occurrence) {
      const existing = this.store.data.tasks!.find(t => t.scheduleId === input.scheduleId && t.occurrence === input.occurrence);
      if (existing) return existing;
    }
    const task: Task = { ...input, id: randomUUID().slice(0, 8), status: 'queued', createdAt: new Date().toISOString() };
    this.store.data.tasks!.push(task);
    return task;
  }
  async enqueue(input: Omit<Task, 'id' | 'status' | 'createdAt'>): Promise<Task> { const task = this.insert(input); await this.store.save(); return task; }
  async claim(): Promise<Task | undefined> {
    if (this.store.data.queuePaused || this.store.data.tasks!.some(t => t.status === 'running')) return;
    const task = this.store.data.tasks!.find(t => t.status === 'queued');
    if (!task) return;
    task.status = 'running'; task.startedAt = new Date().toISOString(); await this.store.save(); return task;
  }
  async finish(id: string, status: Task['status']): Promise<void> {
    const task = this.store.data.tasks!.find(t => t.id === id);
    if (!task) throw new Error('Task not found.');
    task.status = status; task.finishedAt = new Date().toISOString();
    const schedule = this.store.data.schedules!.find(s => s.id === task.scheduleId);
    if (schedule) schedule.lastStatus = status;
    await this.store.save();
  }
  async cancelTask(id: string): Promise<void> {
    const task = this.store.data.tasks!.find(t => t.id === id);
    if (!task || task.status !== 'queued') throw new Error('Only queued tasks can be cancelled here; use Stop for a running task.');
    await this.finish(id, 'cancelled');
  }
  async retryTask(id: string): Promise<Task> {
    const task = this.store.data.tasks!.find(t => t.id === id);
    if (!task || !['failed', 'interrupted', 'cancelled'].includes(task.status)) throw new Error('Choose a failed or interrupted task.');
    if (task.prompt === '[Deleted session]') throw new Error('This task belongs to a permanently deleted chat.');
    return this.enqueue({ kind: task.kind, project: task.project, chatKey: task.chatKey, prompt: task.prompt, interactive: task.interactive, settings: task.settings });
  }
  async prioritize(id: string): Promise<void> {
    const list = this.store.data.tasks!; const i = list.findIndex(t => t.id === id && t.status === 'queued');
    if (i < 0) throw new Error('Queued task not found.');
    list.unshift(...list.splice(i, 1)); await this.store.save();
  }
  async setPaused(paused: boolean): Promise<void> { this.store.data.queuePaused = paused; await this.store.save(); }
  private makeSchedule(input: ScheduleInput, now: Date): Schedule {
    projectName(input.project);
    if (!input.name.trim() || input.name.length > 80 || !input.prompt.trim() || input.prompt.length > 10000) throw new Error('Use a short name and a nonempty task.');
    if (![input.at, input.cron, input.intervalMinutes].filter(v => v !== undefined).length || [input.at, input.cron, input.intervalMinutes].filter(v => v !== undefined).length !== 1) throw new Error('Choose exactly one: at, cron or intervalMinutes.');
    if (input.intervalMinutes !== undefined && (!Number.isSafeInteger(input.intervalMinutes) || input.intervalMinutes < 1)) throw new Error('Interval must be at least one whole minute.');
    const s: Schedule = { ...input, id: randomUUID().slice(0, 8), timezone: input.timezone ?? 'Asia/Kolkata', nextRun: '', enabled: true };
    s.nextRun = next(s, now);
    if (Date.parse(s.nextRun) <= +now) throw new Error('Choose a future date/time.');
    return s;
  }
  async createSchedule(input: ScheduleInput, now = new Date()): Promise<Schedule> {
    const s = this.makeSchedule(input, now); this.store.data.schedules!.push(s); await this.store.save(); return s;
  }
  async changeSchedule(id: string, action: 'pause' | 'resume' | 'delete', now = new Date()): Promise<void> {
    const list = this.store.data.schedules!; const s = list.find(s => s.id === id);
    if (!s) throw new Error('Schedule not found.');
    if (action === 'delete') this.store.data.schedules = list.filter(x => x.id !== id);
    else { s.enabled = action === 'resume'; if (s.enabled && (s.cron || s.intervalMinutes)) s.nextRun = next(s, now); }
    for (const task of this.store.data.tasks!.filter(t => t.scheduleId === id && t.status === 'queued')) {
      if (action !== 'resume') task.status = 'cancelled';
    }
    await this.store.save();
  }
  async editSchedule(id: string, input: ScheduleInput, now = new Date()): Promise<Schedule> {
    const old = this.store.data.schedules!.find(s => s.id === id); if (!old) throw new Error('Schedule not found.');
    const fresh = this.makeSchedule(input, now); fresh.id = old.id;
    this.store.data.schedules = this.store.data.schedules!.map(s => s.id === old.id ? fresh : s);
    for (const t of this.store.data.tasks!.filter(t => t.scheduleId === id && t.status === 'queued')) t.status = 'cancelled';
    await this.store.save(); return fresh;
  }
  async tick(now = new Date()): Promise<number> {
    let added = 0; let changed = false;
    for (const s of this.store.data.schedules!) {
      if (!s.enabled || Date.parse(s.nextRun) > +now) continue;
      const occurrence = s.nextRun;
      if (!this.store.data.tasks!.some(t => t.scheduleId === s.id && ['queued', 'running'].includes(t.status))) {
        this.insert({ kind: s.kind, project: s.project, chatKey: 'schedule-' + s.id, prompt: s.prompt, scheduleId: s.id, occurrence, interactive: false }); added++;
      }
      s.lastRun = occurrence;
      if (s.cron || s.intervalMinutes) s.nextRun = next(s, now); else s.enabled = false;
      changed = true;
    }
    if (changed) await this.store.save();
    return added;
  }
}
