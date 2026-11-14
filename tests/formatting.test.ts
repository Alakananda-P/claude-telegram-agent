import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramChunks } from '../src/formatting.js';

test('Telegram formatting escapes raw HTML and renders headings, links and literal code', () => {
  const text = '# Result\n**Ready** and *checked* [source](https://example.org/?a=1&b=2)\n<script>bad()</script>\n```python\nprint("**literal** <tag> &")\n```';
  const parts = telegramChunks(text); assert.equal(parts.length, 1);
  const html = parts[0].html;
  assert.match(html, /<b>Result<\/b>/); assert.match(html, /<b>Ready<\/b>/); assert.match(html, /<i>checked<\/i>/);
  assert.match(html, /href="https:\/\/example.org\/\?a=1&amp;b=2"/);
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre><code class="language-python">print\(&quot;\*\*literal\*\* &lt;tag&gt; &amp;&quot;\)/);
  assert.ok(!telegramChunks('[click](javascript:alert(1))')[0].html.includes('<a'));
});

test('long Unicode code and inline formatting chunk into independent balanced Telegram messages without loss', () => {
  const code = '🙂 & < > " '.repeat(1000), parts = telegramChunks('```text\n' + code + '\n```', 400);
  assert.ok(parts.length > 10);
  assert.equal(parts.map(p => p.plain).join(''), code + '\n');
  for (const part of parts) {
    assert.ok(part.html.length <= 400); assert.ok(!/[\ud800-\udbff]$/.test(part.plain));
    assert.equal((part.html.match(/<pre>/g) ?? []).length, (part.html.match(/<\/pre>/g) ?? []).length);
  }
  const bold = telegramChunks('**' + 'x'.repeat(8000) + '**');
  assert.equal(bold.map(p => p.plain).join(''), 'x'.repeat(8000));
  assert.ok(bold.every(p => p.html.startsWith('<b>') && p.html.endsWith('</b>')));
});

test('Markdown tables become readable monospaced rows with full values', () => {
  const parts = telegramChunks('| Item | Amount |\n|---|---:|\n| Book | ₹1,280 |\n| Pen | ₹20 |');
  assert.match(parts[0].html, /<pre>/); assert.match(parts[0].plain, /Book\s+│ ₹1,280/);
  assert.ok(!parts[0].plain.includes('---:')); assert.match(parts[0].plain, /Pen/);
});
