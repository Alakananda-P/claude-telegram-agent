import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { State } from './state.js';

/** Metadata-only incident evidence: never returns prompts, tool contents,
 * reasoning, credential values or provider explanation prose. Read-only. */
export async function diagnoseFailedSessions(dataDir: string, state: State) {
  const ids = new Set<string>();
  for (const task of state.tasks ?? []) if (task.status === 'failed') {
    let id = task.chatKey; const seen = new Set<string>();
    while (state.bindings?.[id] && !seen.has(id)) { seen.add(id); id = state.bindings[id]; }
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(id)) ids.add(id);
  }
  const root = path.join(dataDir,'claude','projects'), results = [];
  const projects = await readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for (const project of projects.filter(p=>p.isDirectory()&&!p.isSymbolicLink())) {
    const files=await readdir(path.join(root,project.name),{withFileTypes:true});
    for (const file of files.filter(f=>f.isFile()&&!f.isSymbolicLink()&&f.name.endsWith('.jsonl')&&ids.has(f.name.slice(0,-6)))) {
      const models = new Set<string>(), categories = new Set<string>(); let refusals=0, sessionFallbacks=0, safeguardNotices=0;
      const stream=createReadStream(path.join(root,project.name,file.name),{encoding:'utf8'}), lines=createInterface({input:stream,crlfDelay:Infinity});
      try { for await (const line of lines) {
        let row: any;try {row=JSON.parse(line);}catch{continue;}
        if (row.isSidechain || row.parent_tool_use_id) continue;
        const model=row.message?.model;if(typeof model==='string'&&/^claude-[a-z0-9.-]+$/.test(model))models.add(model);
        if(row.message?.stop_reason==='refusal'||row.stop_reason==='refusal')refusals++;
        if(row.subtype==='model_refusal_fallback'&&row.scope!=='local')sessionFallbacks++;
        const category=row.message?.stop_details?.category??row.api_refusal_category;
        if(typeof category==='string'&&/^[a-z0-9_-]{1,64}$/i.test(category))categories.add(category);
        // Some CLI versions persist only a refusal banner rather than a typed
        // system event. Count the marker, never retain its surrounding content.
        if(row.type==='system'||row.type==='assistant') {
          const content=typeof row.content==='string'?row.content:JSON.stringify(row.message?.content??'');
          if(/safeguards stopped|stopped by a safety classifier|model_refusal/i.test(content))safeguardNotices++;
        }
      }} finally {lines.close();stream.destroy();}
      results.push({session:file.name.slice(0,-6),refusals,sessionFallbacks,safeguardNotices,models:[...models],categories:[...categories]});
    }
  }
  return results;
}
