type Run = { plain: string; open?: string; close?: string };
export interface TelegramChunk { html: string; plain: string }
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text: string, depth = 0): Run[] {
  if (depth > 4) return [{ plain: text }];
  const pattern = /(`+)([^\n]*?)\1|\[([^\]\n]+)\]\((https?:\/\/[^\s<>]+?)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<!\w)_([^_\n]+?)_(?!\w)|~~([^\n]+?)~~/g;
  const runs: Run[] = []; let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) runs.push({ plain: text.slice(offset, match.index) });
    if (match[1]) runs.push({ plain: match[2], open: '<code>', close: '</code>' });
    else if (match[3]) runs.push({ plain: match[3], open: `<a href="${escape(match[4])}">`, close: '</a>' });
    else {
      const tag = match[5] || match[6] ? 'b' : match[9] ? 's' : 'i';
      const content = match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9];
      runs.push(...inline(content, depth + 1).map(r => ({ ...r, open: `<${tag}>` + (r.open ?? ''), close: (r.close ?? '') + `</${tag}>` })));
    }
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) runs.push({ plain: text.slice(offset) });
  return runs;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, '|')).map(r => r.plain).join(''));
function table(lines: string[]): string {
  const rows = lines.filter((_, i) => i !== 1).map(cells);
  const count = Math.max(...rows.map(r => r.length));
  const widths = Array.from({ length: count }, (_, col) => Math.min(40, Math.max(...rows.map(r => Array.from(r[col] ?? '').length))));
  const formatted: string[] = [];
  rows.forEach((row, rowIndex) => {
    const wrapped = widths.map((_, col) => { const chars = Array.from(row[col] ?? ''); const out: string[] = []; do { out.push(chars.splice(0, Math.max(1, widths[col])).join('')); } while (chars.length); return out; });
    for (let i = 0; i < Math.max(...wrapped.map(c => c.length)); i++) formatted.push(widths.map((w, col) => { const value = wrapped[col][i] ?? ''; return value + ' '.repeat(Math.max(0, w - Array.from(value).length)); }).join(' │ ').trimEnd());
    if (rowIndex === 0) formatted.push(widths.map(w => '─'.repeat(w)).join('─┼─'));
  });
  return formatted.join('\n');
}

/** Each emitted run closes its own tags; no chunk splits an entity or code point. */
export function telegramChunks(text: string, maximum = 3800): TelegramChunk[] {
  if (!Number.isSafeInteger(maximum) || maximum < 256 || maximum > 4000) throw new Error('Invalid Telegram chunk size.');
  const runs: Run[] = [], lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const newline = i < lines.length - 1 ? '\n' : '';
    const fence = /^\s*(`{3,}|~{3,})([a-zA-Z0-9_+-]{0,32})\s*$/.exec(lines[i]);
    if (fence) {
      const code: string[] = []; let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i].trim().startsWith(fence[1]) && /^\s*(?:`{3,}|~{3,})\s*$/.test(lines[i])) { closed = true; break; }
        code.push(lines[i]);
      }
      const language = fence[2] ? ` class="language-${fence[2]}"` : '';
      runs.push({ plain: code.join('\n') + (closed ? '\n' : ''), open: `<pre><code${language}>`, close: '</code></pre>' });
      if (i < lines.length - 1) runs.push({ plain: '\n' });
    } else if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const rows = [lines[i], lines[++i]];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(lines[++i]);
      runs.push({ plain: table(rows), open: '<pre>', close: '</pre>' });
      if (i < lines.length - 1) runs.push({ plain: '\n' });
    } else {
      const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(lines[i]);
      if (heading) runs.push(...inline(heading[1]).map(r => ({ ...r, open: '<b>' + (r.open ?? ''), close: (r.close ?? '') + '</b>' })));
      else runs.push(...inline(lines[i].replace(/^(\s*)[-+*] /, '$1• ')));
      if (newline) runs.push({ plain: newline });
    }
  }
  const parts: TelegramChunk[] = []; let current: TelegramChunk = { html: '', plain: '' };
  const flush = () => { if (current.html) parts.push(current); current = { html: '', plain: '' }; };
  for (const run of runs) {
    let open = run.open ?? '', close = run.close ?? '';
    // An abnormally long link target is readable text rather than an oversized tag.
    if (open.length + close.length > maximum / 2) { open = ''; close = ''; }
    let raw = '', html = '';
    const append = () => { if (html) { current.html += open + html + close; current.plain += raw; raw = ''; html = ''; } };
    for (const char of run.plain) {
      const encoded = escape(char);
      if (current.html.length + open.length + html.length + encoded.length + close.length > maximum) { append(); flush(); }
      raw += char; html += encoded;
    }
    append();
  }
  flush(); return parts;
}
