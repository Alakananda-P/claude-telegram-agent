import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseFailedSessions } from '../src/diagnostics.js';
import { StateStore } from '../src/state.js';

test('session diagnostic reports refusal and fallback metadata, not prompts, tokens or reasoning', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'tg-diagnostics-')), store=await StateStore.open(path.join(dir,'state.json'));
 const session='8390f92f-64da-4e62-93cd-2a01f9663fa1';
 store.data.tasks=[{id:'failure',kind:'agent',project:'default',chatKey:'draft-one',prompt:'PRIVATE PROMPT',status:'failed',createdAt:new Date().toISOString()}];store.data.bindings!['draft-one']=session;
 const project=path.join(dir,'claude/projects/default');await mkdir(project,{recursive:true});
 const rows=[{type:'assistant',message:{model:'claude-opus-5-5',stop_reason:'refusal',stop_details:{category:'cyber',explanation:'PRIVATE EXPLANATION'},content:[{type:'thinking',thinking:'PRIVATE REASONING'}]}},{type:'system',subtype:'model_refusal_fallback',scope:'session',original_model:'claude-opus-5-5',fallback_model:'claude-sonnet-5-5',api_refusal_category:'cyber',api_refusal_explanation:'PRIVATE KEY'},{type:'assistant',message:{model:'claude-sonnet-5-5',content:[{type:'text',text:'PRIVATE REPLY'}]}}];
 await writeFile(path.join(project,session+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));
 const diagnostics=await diagnoseFailedSessions(dir,store.data);
 assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].refusals,1);assert.equal(diagnostics[0].sessionFallbacks,1);assert.deepEqual(diagnostics[0].models,['claude-opus-5-5','claude-sonnet-5-5']);assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE'));
});
