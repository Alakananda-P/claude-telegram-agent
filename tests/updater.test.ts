import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateClient, updateConfig, type Http } from '../src/updater.js';

const env = { RENDER_API_KEY: 'rnd_test_only', RENDER_SERVICE_ID: 'srv-abc123', GITHUB_TOKEN: 'github_pat_test_only', GITHUB_REPOSITORY_URL: 'https://github.com/owner/bot.git', BACKUP_REPOSITORY: 'owner/bot-previous' };
const live = 'a'.repeat(40), next = 'b'.repeat(40);

/** Fake GitHub + Render. Records every call; fails any route in `broken`. */
function fake(broken: string[] = []) {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  const backup: { blobs: string[]; tree?: unknown; ref?: string } = { blobs: [] };
  const http: Http = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ method: init.method, url, body, auth: init.headers.authorization });
    const reply = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data });
    const route = `${init.method} ${url.replace(/^https:\/\/api\.(github|render)\.com/, '')}`;
    if (broken.some(b => route.startsWith(b))) return reply({ message: 'nope' }, 500);
    if (route === 'GET /v1/services/srv-abc123/deploys?limit=20') return reply([{ deploy: { id: 'dep-new-failed', status: 'build_failed', commit: { id: next } } }, { deploy: { id: 'dep-live', status: 'live', commit: { id: live } } }]);
    if (route === 'POST /v1/services/srv-abc123/deploys') return reply({ id: 'dep-2', status: 'created', commit: { id: body.commitId } }, 201);
    if (route === 'GET /v1/services/srv-abc123/deploys/dep-2') return reply({ id: 'dep-2', status: 'live', commit: { id: next } });
    if (route === 'POST /v1/services/srv-abc123/rollback') return reply({ id: 'dep-3', status: 'created', commit: { id: live } }, 201);
    if (route === 'GET /repos/owner/bot/commits/main') return reply({ sha: next });
    if (route === `GET /repos/owner/bot/compare/${live}...${next}`) return reply({ commits: [{ commit: { message: 'Fix the hang\n\nlong body' } }, { commit: { message: 'Add /plan' } }] });
    if (route === `GET /repos/owner/bot/git/commits/${live}`) return reply({ tree: { sha: 'tree-live' } });
    if (route === 'GET /repos/owner/bot/git/trees/tree-live?recursive=1') return reply({ truncated: false, tree: [{ path: 'src', mode: '040000', type: 'tree', sha: 'dir' }, { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'blob-a' }, { path: 'run.sh', mode: '100755', type: 'blob', sha: 'blob-b' }] });
    if (route.startsWith('GET /repos/owner/bot/git/blobs/')) return reply({ content: Buffer.from(url.slice(-6)).toString('base64') + '\n', encoding: 'base64' });
    if (route === 'POST /repos/owner/bot-previous/git/blobs') { backup.blobs.push(body.content); return reply({ sha: 'x' }, 201); }
    if (route === 'POST /repos/owner/bot-previous/git/trees') { backup.tree = body.tree; return reply({ sha: broken.includes('tree-mismatch') ? 'other' : 'tree-live' }, 201); }
    if (route === 'POST /repos/owner/bot-previous/git/commits') return reply({ sha: 'snap-1' }, 201);
    if (route === 'PATCH /repos/owner/bot-previous/git/refs/heads/main') { backup.ref = body.sha; return reply({}, 200); }
    return reply({ message: 'unexpected ' + route }, 599);
  };
  return { http, calls, backup };
}

test('update settings come from the environment and are "not configured" when any part is missing', () => {
  assert.deepEqual(updateConfig(env), { renderKey: 'rnd_test_only', serviceId: 'srv-abc123', githubToken: 'github_pat_test_only', sourceRepo: 'owner/bot', backupRepo: 'owner/bot-previous' });
  for (const key of Object.keys(env)) assert.equal(updateConfig({ ...env, [key]: '' }), undefined, key);
  assert.equal(updateConfig({ ...env, BACKUP_REPOSITORY: 'owner/bot' }), undefined, 'the backup must be a different repo');
  assert.equal(updateConfig({ ...env, RENDER_SERVICE_ID: 'srv-x; rm' }), undefined);
});

test('the client reads the live deploy and main, starts a deploy and a rollback, and sends keys only as headers', async () => {
  const { http, calls } = fake(); const client = new UpdateClient(updateConfig(env)!, http);
  assert.deepEqual(await client.liveDeploy(), { id: 'dep-live', status: 'live', commit: live });
  assert.equal(await client.mainCommit(), next);
  assert.deepEqual(await client.changes(live, next), ['Fix the hang', 'Add /plan']);
  assert.equal(await client.deploy(next), 'dep-2');
  assert.deepEqual(calls.at(-1)!.body, { clearCache: 'do_not_clear', commitId: next });
  assert.equal((await client.deployStatus('dep-2')).status, 'live');
  assert.equal(await client.rollback('dep-live'), 'dep-3'); assert.deepEqual(calls.at(-1)!.body, { deployId: 'dep-live' });
  assert.ok(calls.every(c => !c.url.includes('test_only') && !JSON.stringify(c.body ?? '').includes('test_only')));
  assert.ok(calls.filter(c => c.url.includes('render.com')).every(c => c.auth === 'Bearer rnd_test_only'));
  assert.ok(calls.filter(c => c.url.includes('github.com')).every(c => c.auth === 'Bearer github_pat_test_only'));
});

test('the backup copies the live tree as one commit and fails when the copy does not match', async () => {
  const ok = fake(); const client = new UpdateClient(updateConfig(env)!, ok.http);
  assert.equal(await client.backup(live), 'snap-1');
  assert.equal(ok.backup.blobs.length, 2); assert.ok(ok.backup.blobs.every(b => !b.includes('\n')));
  assert.deepEqual(ok.backup.tree, [{ path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'blob-a' }, { path: 'run.sh', mode: '100755', type: 'blob', sha: 'blob-b' }]);
  assert.equal(ok.backup.ref, 'snap-1');
  assert.deepEqual(ok.calls.find(c => c.url.endsWith('/bot-previous/git/commits'))!.body, { message: `Live version ${live.slice(0, 7)} (backup before /update)`, tree: 'tree-live', parents: [] });
  const mismatch = fake(['tree-mismatch']);
  await assert.rejects(new UpdateClient(updateConfig(env)!, mismatch.http).backup(live), /does not match/);
  assert.equal(mismatch.backup.ref, undefined, 'main is never moved to a bad copy');
  const down = fake(['POST /repos/owner/bot-previous/git/blobs']);
  await assert.rejects(new UpdateClient(updateConfig(env)!, down.http).backup(live), error => /GitHub returned HTTP 500/.test(String(error)) && !String(error).includes('test_only'));
});
