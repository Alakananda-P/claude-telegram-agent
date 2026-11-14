import { ProjectCatalog, ProjectError } from './projects.js';
import { button, BACK, type Buttons } from './ui.js';
import { privatePreview } from './safety.js';

export type ProjectTab = 'active' | 'archived' | 'trashed';
export class ProjectUI {
  constructor(private catalog: ProjectCatalog, private secrets: string[]) {}
  async page(status: ProjectTab = 'active', page = 0) {
    if (!['active', 'archived', 'trashed'].includes(status) || !Number.isSafeInteger(page) || page < 0) throw new ProjectError('Choose a valid project page.');
    let view = await this.catalog.list({ status, offset: page * 8, limit: 8 });
    const pages = Math.max(1, Math.ceil(view.total / 8));
    if (page >= pages) { page = pages - 1; view = await this.catalog.list({ status, offset: page * 8, limit: 8 }); }
    const labels = { active: 'Active', archived: 'Archived', trashed: 'Trash' };
    const nav = [...(page ? [button('Previous', `ppage ${status} ${page - 1}`)] : []), ...(view.nextOffset !== null ? [button('Next', `ppage ${status} ${page + 1}`)] : [])];
    const buttons: Buttons = [
      ...view.projects.map(p => [button((p.selected ? '✓ ' : '') + privatePreview(p.name, this.secrets, 42), 'pinfo ' + p.id)]),
      ...(nav.length ? [nav] : []),
      [button('Active', 'ppage active 0'), button('Archived', 'ppage archived 0'), button('Trash', 'ppage trashed 0')],
      [button('＋ New project', 'pnew')], ...BACK,
    ];
    const rows = view.projects.map(p => `${p.selected ? '✓ ' : ''}${p.name}\n${p.counts.chats} chat(s) · ${p.counts.enabledSchedules} active schedule(s)`).join('\n\n');
    return { text: `Projects · ${labels[status]} · ${view.total}\nPage ${page + 1}/${pages}\n\n${rows || 'No projects here.'}\n\n${status === 'trashed' ? 'Projects in Trash are permanently deleted after 48 hours.' : 'Choose a project, or ask Claude to create, rename or manage one.'}`, buttons };
  }
  async detail(id: string) {
    const p = await this.catalog.get(id), buttons: Buttons = [];
    if (p.status === 'active') {
      if (!p.selected) buttons.push([button('Open project', 'project ' + id)]);
      buttons.push([button('Edit name / details', 'pedit ' + id), button('Files', 'pfiles ' + id + ' 0')]);
      buttons.push([button('Archive', 'parchive ' + id), button('Move to Trash', 'ptrash ' + id)]);
    } else if (p.status === 'archived') {
      buttons.push([button('Restore project', 'prestore ' + id), button('Files', 'pfiles ' + id + ' 0')]);
      buttons.push([button('Edit name / details', 'pedit ' + id), button('Move to Trash', 'ptrash ' + id)]);
    } else if (p.status === 'trashed') {
      if (p.purgeAt && Date.parse(p.purgeAt) > Date.now()) buttons.push([button('Restore project', 'prestore ' + id)]);
      buttons.push([button('Delete forever', 'ppurge ' + id)]);
    }
    buttons.push([button('Projects', 'projects')], ...BACK);
    const deadline = p.purgeAt && p.status === 'trashed' ? '\nDeletes: ' + new Date(p.purgeAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) + ' IST' : '';
    return { text: `${p.name}${p.selected ? ' · selected' : ''}\n${p.status} · ID: ${p.id}${deadline}\n\n${privatePreview(p.description, this.secrets, 900) || 'No description yet.'}\n\nChats: ${p.counts.chats}\nQueued / running tasks: ${p.counts.queuedTasks} / ${p.counts.runningTasks}\nEnabled schedules: ${p.counts.enabledSchedules}\nRunning background jobs: ${p.counts.runningBackgroundJobs}\n\n${p.status === 'archived' ? 'Files and chats are kept. Restore to work here; schedules stay paused.' : p.status === 'trashed' ? 'Restore within 48 hours. Global shared memory and lifetime usage are kept.' : 'Ask naturally to build, inspect or edit this project.'}`, buttons };
  }
  async files(id: string, offset = 0) {
    const p = await this.catalog.get(id), view = await this.catalog.listFiles(id, { offset, limit: 20 });
    return { text: `${p.name} · Files\n\n${view.files.map(f => (f.type === 'directory' ? '📁 ' : '📄 ') + f.name).join('\n') || 'No files on this page.'}\n\nAsk Claude to inspect folders, create or edit files. Open the project before using /get.`,
      buttons: [...(offset ? [[button('Previous', `pfiles ${id} ${Math.max(0, offset - 20)}`)]] : []), ...(view.nextOffset !== null ? [[button('More files', `pfiles ${id} ${view.nextOffset}`)]] : []), [button('Project', 'pinfo ' + id)], ...BACK] };
  }
}
