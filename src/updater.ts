/** GitHub + Render calls for /update and /de_update. Keys travel only in request headers and
 * never appear in errors, logs or messages. Deploys and rollbacks run only after the owner's tap. */

export interface UpdateConfig { renderKey: string; serviceId: string; githubToken: string; sourceRepo: string; backupRepo: string }
export interface Deploy { id: string; commit: string; status: string }
/** Saved when the owner confirms /update. */
export interface UpdateRecord { previousDeployId: string; previousCommit: string; targetCommit: string; deployId?: string; startedAt: string; result?: string; reportedAt?: string }
/** What the controller needs; the fake in tests implements the same calls. */
export type Updates = Pick<UpdateClient, 'liveDeploy' | 'mainCommit' | 'changes' | 'backup' | 'deploy' | 'deployStatus' | 'rollback'>;
export type Http = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const repoName = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** Statuses after which a Render deploy will not change any more. */
export const FINAL_DEPLOY_STATUSES = ['live', 'deactivated', 'build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'];

/** Reads the update settings from the environment. Undefined means /update answers "not configured". */
export function updateConfig(env: NodeJS.ProcessEnv): UpdateConfig | undefined {
  const renderKey = env.RENDER_API_KEY?.trim(), serviceId = env.RENDER_SERVICE_ID?.trim(), githubToken = env.GITHUB_TOKEN?.trim();
  const sourceRepo = env.GITHUB_REPOSITORY?.trim() || /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(env.GITHUB_REPOSITORY_URL?.trim() ?? '')?.[1];
  const backupRepo = env.BACKUP_REPOSITORY?.trim();
  if (!renderKey || !serviceId || !/^srv-[a-z0-9]{1,64}$/.test(serviceId) || !githubToken || !sourceRepo || !repoName.test(sourceRepo) || !backupRepo || !repoName.test(backupRepo) || backupRepo === sourceRepo) return;
  return { renderKey, serviceId, githubToken, sourceRepo, backupRepo };
}

export class UpdateError extends Error {}

export class UpdateClient {
  constructor(private config: UpdateConfig, private http: Http = fetch as unknown as Http) {}

  private async call(service: 'GitHub' | 'Render', url: string, method = 'GET', body?: unknown, allow: number[] = []): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = service === 'GitHub'
      ? { authorization: `Bearer ${this.config.githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'private-telegram-agent', 'x-github-api-version': '2022-11-28' }
      : { authorization: `Bearer ${this.config.renderKey}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try { response = await this.http(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
    catch { throw new UpdateError(`${service} could not be reached.`); }
    if (!response.ok && !allow.includes(response.status)) throw new UpdateError(`${service} returned HTTP ${response.status}.`);
    return { status: response.status, data: await response.json().catch(() => undefined) };
  }
  private gh(path: string, method?: string, body?: unknown, allow?: number[]) { return this.call('GitHub', 'https://api.github.com' + path, method, body, allow); }
  private render(path: string, method?: string, body?: unknown) { return this.call('Render', `https://api.render.com/v1/services/${this.config.serviceId}` + path, method, body); }

  /** The deploy that is live now. */
  async liveDeploy(): Promise<Deploy> {
    const { data } = await this.render('/deploys?limit=20');
    const live = (Array.isArray(data) ? data : []).map(d => toDeploy((d as { deploy?: unknown })?.deploy ?? d)).find(d => d?.status === 'live');
    if (!live) throw new UpdateError('Render shows no live deploy.');
    return live;
  }
  async deployStatus(id: string): Promise<Deploy> {
    const deploy = toDeploy((await this.render('/deploys/' + encodeURIComponent(id))).data);
    if (!deploy) throw new UpdateError('Render returned an unreadable deploy.');
    return deploy;
  }
  /** Starts a deploy of one exact commit. */
  async deploy(commit: string): Promise<string> {
    const deploy = toDeploy((await this.render('/deploys', 'POST', { clearCache: 'do_not_clear', commitId: commit })).data);
    if (!deploy) throw new UpdateError('Render did not return the new deploy.');
    return deploy.id;
  }
  /** Rolls back to an earlier deploy (no rebuild). */
  async rollback(deployId: string): Promise<string> {
    const deploy = toDeploy((await this.render('/rollback', 'POST', { deployId })).data);
    if (!deploy) throw new UpdateError('Render did not return the rollback deploy.');
    return deploy.id;
  }
  /** Newest commit on the source repo's main branch. */
  async mainCommit(): Promise<string> {
    const sha = ((await this.gh(`/repos/${this.config.sourceRepo}/commits/main`)).data as { sha?: unknown })?.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new UpdateError('GitHub returned no main commit.');
    return sha;
  }
  /** First lines of the commit messages between two commits (at most 20). */
  async changes(from: string, to: string): Promise<string[]> {
    const commits = ((await this.gh(`/repos/${this.config.sourceRepo}/compare/${from}...${to}`)).data as { commits?: { commit?: { message?: unknown } }[] })?.commits ?? [];
    return commits.map(c => String(c.commit?.message ?? '').split('\n')[0].slice(0, 120)).filter(Boolean).slice(-20);
  }

  /** Replaces the backup repo's main with ONE commit holding the source tree at `commit`.
   * The copied tree must hash to the source tree, otherwise the copy is reported as failed. */
  async backup(commit: string): Promise<string> {
    const { sourceRepo: src, backupRepo: bak } = this.config;
    const tree = ((await this.gh(`/repos/${src}/git/commits/${commit}`)).data as { tree?: { sha?: string } })?.tree?.sha;
    if (!tree) throw new UpdateError('GitHub returned no tree for the live commit.');
    const listing = (await this.gh(`/repos/${src}/git/trees/${tree}?recursive=1`)).data as { truncated?: boolean; tree?: { path: string; mode: string; type: string; sha: string }[] };
    if (!listing?.tree || listing.truncated) throw new UpdateError('The live code tree is too large to copy.');
    if (listing.tree.some(e => e.type === 'commit')) throw new UpdateError('The live code has submodules; the backup copy does not support them.');
    const files = listing.tree.filter(e => e.type === 'blob');
    for (const file of files) {
      const blob = (await this.gh(`/repos/${src}/git/blobs/${file.sha}`)).data as { content?: string; encoding?: string };
      if (typeof blob?.content !== 'string' || blob.encoding !== 'base64') throw new UpdateError('GitHub returned an unreadable file.');
      await this.gh(`/repos/${bak}/git/blobs`, 'POST', { content: blob.content.replace(/\n/g, ''), encoding: 'base64' });
    }
    const copied = ((await this.gh(`/repos/${bak}/git/trees`, 'POST', { tree: files.map(f => ({ path: f.path, mode: f.mode, type: 'blob', sha: f.sha })) })).data as { sha?: string })?.sha;
    if (copied !== tree) throw new UpdateError('The backup copy does not match the live code.');
    const snapshot = ((await this.gh(`/repos/${bak}/git/commits`, 'POST', { message: `Live version ${commit.slice(0, 7)} (backup before /update)`, tree: copied, parents: [] })).data as { sha?: string })?.sha;
    if (!snapshot) throw new UpdateError('GitHub did not create the backup commit.');
    const moved = await this.gh(`/repos/${bak}/git/refs/heads/main`, 'PATCH', { sha: snapshot, force: true }, [404, 422]);
    if (moved.status === 404 || moved.status === 422) await this.gh(`/repos/${bak}/git/refs`, 'POST', { ref: 'refs/heads/main', sha: snapshot });
    return snapshot;
  }
}

function toDeploy(value: unknown): Deploy | undefined {
  const d = value as { id?: unknown; status?: unknown; commit?: { id?: unknown } } | undefined;
  return typeof d?.id === 'string' && typeof d.status === 'string' ? { id: d.id, status: d.status, commit: typeof d.commit?.id === 'string' ? d.commit.id : '' } : undefined;
}
