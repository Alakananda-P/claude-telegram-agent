import { randomBytes } from 'node:crypto';
import { button, BACK, type Buttons } from './ui.js';
import { TelegramError } from './telegram.js';

export class GameError extends Error { constructor(message: string) { super(message); this.name = 'GameError'; } }

export interface QuizQuestion { question: string; options: string[]; answer: number; explanation?: string }
export type Level = 'easy' | 'medium' | 'hard';
export type Cell = '' | 'X' | 'O';
export type GameKind = 'quiz' | 'rapid' | 'ttt' | 'hangman';

export interface GameResult {
  at: string;
  kind: GameKind;
  title: string;
  outcome: 'won' | 'lost' | 'draw' | 'done' | 'stopped';
  score?: number;
  total?: number;
}
interface ActiveGame {
  id: string;
  kind: GameKind;
  title?: string;
  statusId?: number;
  boardId?: number;
  pollId?: string;
  pollMessageId?: number;
  deadline?: number;
  questions?: QuizQuestion[];
  index?: number;
  score?: number;
  timer?: number;
  locked?: boolean;
  board?: Cell[];
  level?: Level;
  word?: string;
  hint?: string;
  guessed?: string[];
}
export interface GamesData { active?: ActiveGame; results?: GameResult[] }
export interface PlayInput {
  kind: GameKind;
  title?: string;
  timer_seconds?: number;
  questions?: QuizQuestion[];
  level?: Level;
  word?: string;
  hint?: string;
}
export interface IncomingPollAnswer { poll_id: string; option_ids?: number[]; user?: { id: number }; voter?: { id: number } }
export interface GameHost {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  panel(text: string, buttons: Buttons): Promise<void>;
  say(text: string): Promise<void>;
}
export interface GameStore { data: { games?: GamesData }; save(): Promise<void> }
export interface GameOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (ms: number, fn: () => void) => { cancel(): void };
  newId?: () => string;
  pick?: <T>(items: readonly T[]) => T;
  rng?: () => number;
}

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const QUIZ_BANK: QuizQuestion[] = [
  { question: 'GST India mein kab lagu hua?', options: ['1 July 2016', '1 July 2017', '1 April 2017', '1 July 2018'], answer: 1, explanation: 'GST 1 July 2017 se lagu hua.' },
  { question: 'IGST kis supply par lagta hai?', options: ['Same state', 'Interstate', 'Sirf export', 'Sirf import'], answer: 1, explanation: 'IGST interstate supply par lagta hai. Same state par CGST aur SGST.' },
  { question: 'GSTR-1 kis cheez ka return hai?', options: ['Inward supplies', 'Outward supplies', 'Annual return', 'TDS return'], answer: 1, explanation: 'GSTR-1 outward supplies, yaani sales, ka return hai.' },
  { question: 'GSTR-2B kya hai?', options: ['Sales register', 'Auto-drafted ITC statement', 'Tax challan', 'E-way bill'], answer: 1, explanation: 'GSTR-2B auto-drafted ITC statement hai. Purchase register isi se match hota hai.' },
  { question: 'India ki rajdhani kaunsi hai?', options: ['Mumbai', 'Kolkata', 'New Delhi', 'Chennai'], answer: 2, explanation: 'India ki rajdhani New Delhi hai.' },
  { question: 'CA ka full form kya hai?', options: ['Cost Accountant', 'Chartered Accountant', 'Company Auditor', 'Chief Accountant'], answer: 1, explanation: 'CA ka matlab Chartered Accountant hai. Cost Accountant CMA hota hai.' },
  { question: 'PAN mein kitne characters hote hain?', options: ['8', '10', '12', '16'], answer: 1, explanation: 'PAN 10 characters ka hota hai.' },
  { question: 'Accounting mein credit ka ulta kya hai?', options: ['Asset', 'Debit', 'Capital', 'Ledger'], answer: 1, explanation: 'Credit ka ulta Debit hai.' },
];
export const RAPID_BANK: QuizQuestion[] = [
  { question: '7 × 8 = ?', options: ['54', '56', '63', '64'], answer: 1 },
  { question: 'GST ka full form?', options: ['Goods and Services Tax', 'General Sales Tax', 'Goods and Sales Tax', 'General Service Tax'], answer: 0 },
  { question: 'Triangle ki kitni sides hoti hain?', options: ['2', '3', '4', '5'], answer: 1 },
  { question: '100 ÷ 4 = ?', options: ['20', '25', '40', '50'], answer: 1 },
  { question: 'Delhi kis desh mein hai?', options: ['Nepal', 'Bhutan', 'India', 'China'], answer: 2 },
  { question: 'Ek rupaye mein kitne paise?', options: ['10', '50', '100', '1000'], answer: 2 },
  { question: 'Profit ka ulta kya hai?', options: ['Gain', 'Asset', 'Loss', 'Sales'], answer: 2 },
  { question: 'Tally kis kaam ka software hai?', options: ['Photo edit', 'Accounting', 'Video edit', 'Maps'], answer: 1 },
];
export const HANGMAN_BANK: { word: string; hint: string }[] = [
  { word: 'LEDGER', hint: 'accounts ki kitab' }, { word: 'INVOICE', hint: 'bill' }, { word: 'DELHI', hint: 'sheher' },
  { word: 'MONSOON', hint: 'mausam' }, { word: 'CRICKET', hint: 'khel' }, { word: 'PYTHON', hint: 'programming' },
  { word: 'MARKET', hint: 'bazaar' }, { word: 'BUDGET', hint: 'paisa ka plan' }, { word: 'PROFIT', hint: 'fayda' },
  { word: 'VOUCHER', hint: 'Tally entry' }, { word: 'COFFEE', hint: 'peene ki cheez' }, { word: 'MUMBAI', hint: 'sheher' },
];

export function checkQuestion(q: QuizQuestion): QuizQuestion {
  const question = q.question?.replace(/\s+/g, ' ').trim() ?? '';
  const options = (q.options ?? []).map(o => String(o).replace(/\s+/g, ' ').trim());
  if (question.length < 1 || question.length > 280) throw new GameError('Each question must be 1-280 characters.');
  if (options.length < 2 || options.length > 10) throw new GameError('Each question needs 2-10 options.');
  if (options.some(o => o.length < 1 || o.length > 100)) throw new GameError('Each option must be 1-100 characters.');
  if (new Set(options).size !== options.length) throw new GameError('Options in one question must be different.');
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length) throw new GameError('answer is the 0-based index of the correct option.');
  const explanation = q.explanation?.replace(/\s+/g, ' ').trim();
  if (explanation && explanation.length > 200) throw new GameError('Explanation must be at most 200 characters.');
  return { question, options, answer: q.answer, ...(explanation ? { explanation } : {}) };
}
export function cleanWord(word: string): string {
  const w = word.trim().toUpperCase();
  if (!/^[A-Z]{3,12}$/.test(w)) throw new GameError('Hangman word must be 3-12 English letters, with no spaces.');
  return w;
}
export function empties(board: readonly Cell[]): number[] { return board.flatMap((c, i) => c === '' ? [i] : []); }
export function winner(board: readonly Cell[]): Cell | 'draw' | '' {
  for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  return board.every(Boolean) ? 'draw' : '';
}
function minimax(board: Cell[], turn: Cell): number {
  const w = winner(board);
  if (w === 'O') return 1;
  if (w === 'X') return -1;
  if (w === 'draw') return 0;
  let best = turn === 'O' ? -2 : 2;
  for (const i of empties(board)) {
    board[i] = turn;
    const score = minimax(board, turn === 'O' ? 'X' : 'O');
    board[i] = '';
    if (turn === 'O' ? score > best : score < best) best = score;
    if ((turn === 'O' && best === 1) || (turn === 'X' && best === -1)) break;
  }
  return best;
}
function prefer(open: number[], rng: () => number): number {
  if (open.includes(4)) return 4;
  const corners = open.filter(i => i === 0 || i === 2 || i === 6 || i === 8);
  const pool = corners.length ? corners : open;
  return pool[Math.floor(rng() * pool.length)]!;
}
export function botMove(board: readonly Cell[], level: Level, rng: () => number = Math.random): number {
  const open = empties(board);
  if (!open.length) return -1;
  if (level === 'easy') return open[Math.floor(rng() * open.length)]!;
  const find = (who: Cell) => open.find(i => { const next = board.slice() as Cell[]; next[i] = who; return winner(next) === who; });
  const win = find('O'); if (win !== undefined) return win;
  const block = find('X'); if (block !== undefined) return block;
  if (level === 'medium') return prefer(open, rng);
  let best = -2; const picks: number[] = [];
  for (const i of open) {
    const next = board.slice() as Cell[]; next[i] = 'O';
    const score = minimax(next, 'X');
    if (score > best) { best = score; picks.length = 0; picks.push(i); }
    else if (score === best) picks.push(i);
  }
  return prefer(picks, rng);
}
export function hangmanView(word: string, guessed: readonly string[]): { shown: string; won: boolean; misses: string[] } {
  const known = new Set(guessed);
  const misses = guessed.filter(ch => !word.includes(ch));
  return { shown: [...word].map(ch => known.has(ch) ? ch : '_').join(' '), won: [...word].every(ch => known.has(ch)), misses };
}

type Action = { type: 'menu' } | { type: 'quiz' } | { type: 'rapid' } | { type: 'ttt-pick' } | { type: 'ttt'; level: Level } | { type: 'hangman' } | { type: 'stop' } | { type: 'move'; id: string; cell: number } | { type: 'letter'; id: string; letter: string } | { type: 'end'; id: string };
export function parseGameCallback(data: string): Action | undefined {
  if (data === 'g:menu') return { type: 'menu' };
  if (data === 'g:quiz') return { type: 'quiz' };
  if (data === 'g:rapid') return { type: 'rapid' };
  if (data === 'g:ttt') return { type: 'ttt-pick' };
  if (data === 'g:te' || data === 'g:tm' || data === 'g:th') return { type: 'ttt', level: data === 'g:te' ? 'easy' : data === 'g:tm' ? 'medium' : 'hard' };
  if (data === 'g:hm') return { type: 'hangman' };
  if (data === 'g:stop') return { type: 'stop' };
  let m = /^g:m:([a-f0-9]{4}):([0-8])$/.exec(data); if (m) return { type: 'move', id: m[1], cell: Number(m[2]) };
  m = /^g:l:([a-f0-9]{4}):([A-Z])$/.exec(data); if (m) return { type: 'letter', id: m[1], letter: m[2] };
  m = /^g:x:([a-f0-9]{4})$/.exec(data); if (m) return { type: 'end', id: m[1] };
  return undefined;
}

function clampTimer(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 5 || value > 600) throw new GameError('Timer must be 5-600 seconds.');
  return value;
}
function cleanTitle(title: string | undefined, fallback: string): string {
  const t = title?.replace(/\s+/g, ' ').trim().slice(0, 40);
  return t || fallback;
}
function kindLabel(kind: GameKind): string { return kind === 'rapid' ? 'Rapid Fire' : kind === 'ttt' ? 'Tic Tac Toe' : kind === 'hangman' ? 'Hangman' : 'MCQ Quiz'; }
function tttText(game: ActiveGame): string {
  const w = winner(game.board ?? []);
  const head = `Tic Tac Toe ❌⭕\nAp ❌  ·  Myra ⭕  ·  ${game.level ?? 'medium'}`;
  if (w === 'X') return `${head}\n\nAp jeet gaye 🏆`;
  if (w === 'O') return `${head}\n\nMyra jeet gayi 😤`;
  if (w === 'draw') return `${head}\n\nDraw 🤝`;
  return `${head}\n\nApki chaal`;
}
function tttKeys(game: ActiveGame): Buttons {
  const mark = (c: Cell) => c === 'X' ? '❌' : c === 'O' ? '⭕' : '·';
  const rows: Buttons = [0, 1, 2].map(r => [0, 1, 2].map(c => {
    const i = r * 3 + c;
    return { text: mark(game.board![i]!), callback_data: `g:m:${game.id}:${i}` };
  }));
  rows.push([{ text: '⏹ Band', callback_data: `g:x:${game.id}` }]);
  return rows;
}
function hangmanText(game: ActiveGame): string {
  const view = hangmanView(game.word!, game.guessed ?? []);
  return `Hangman 🔤\n${view.shown}\nHint: ${game.hint}\nGalat: ${view.misses.join(' ') || '-'} (${view.misses.length}/6)`;
}
function hangmanKeys(game: ActiveGame): Buttons {
  const used = new Set(game.guessed ?? []);
  const letters = LETTERS.filter(ch => !used.has(ch));
  const rows: Buttons = [];
  for (let i = 0; i < letters.length; i += 7) rows.push(letters.slice(i, i + 7).map(ch => ({ text: ch, callback_data: `g:l:${game.id}:${ch}` })));
  rows.push([{ text: '⏹ Band', callback_data: `g:x:${game.id}` }]);
  return rows;
}
function againKey(kind: GameKind, level?: Level): string {
  if (kind === 'ttt') return level === 'easy' ? 'g:te' : level === 'hard' ? 'g:th' : 'g:tm';
  if (kind === 'hangman') return 'g:hm';
  return kind === 'rapid' ? 'g:rapid' : 'g:quiz';
}
function endKeys(kind: GameKind, level?: Level): Buttons {
  return [[button('🔄 Phir', againKey(kind, level)), button('🎮 Games', 'g:menu')]];
}
const errorName = (error: unknown) => error instanceof Error ? error.name : 'unknown';
const defaultSchedule = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; };

type Toast = (text?: string) => Promise<void>;

/** Owner-chat games. The bot sends the polls and boards and keeps score; the agent only supplies questions. */
export class Games {
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: { cancel(): void };
  constructor(private host: GameHost, private owner: number, private store: GameStore, private options: GameOptions = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  // Awaited inside update handling while no Telegram request is open: an unref'd timer here let Node exit silently.
  private sleep(ms: number): Promise<void> { return this.options.sleep?.(ms) ?? new Promise(r => setTimeout(r, ms)); }
  private newId(): string { return this.options.newId?.() ?? randomBytes(2).toString('hex'); }
  private pick<T>(items: readonly T[]): T { return this.options.pick?.(items) ?? items[Math.floor(Math.random() * items.length)]!; }
  private rng(): () => number { return this.options.rng ?? Math.random; }
  private data(): GamesData {
    if (!this.store.data.games || typeof this.store.data.games !== 'object') this.store.data.games = {};
    if (this.store.data.games.results && !Array.isArray(this.store.data.games.results)) delete this.store.data.games.results;
    return this.store.data.games;
  }
  private async save(): Promise<void> { await this.store.save(); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
  private cancelTimer(): void { this.timer?.cancel(); this.timer = undefined; }
  dispose(): void { this.cancelTimer(); }

  /** A restarted quiz cannot safely resume its open poll, so it is closed. Button games keep their saved board. */
  restore(): void {
    const game = this.data().active;
    if (!game?.id || (game.kind !== 'quiz' && game.kind !== 'rapid')) return;
    void this.enqueue(async () => {
      if (this.data().active?.id !== game.id) return;
      const statusId = game.statusId, pollMessageId = game.pollMessageId;
      await this.record({ at: new Date().toISOString(), kind: game.kind, title: game.title || kindLabel(game.kind), outcome: 'stopped', score: game.score, total: game.questions?.length });
      if (pollMessageId) await this.host.call('stopPoll', { message_id: pollMessageId }).catch(() => {});
      const text = 'Quiz restart pe band ho gaya.\n\n/games se phir shuru karo.';
      if (statusId) await this.edit(statusId, text).catch(() => this.host.say(text));
      else await this.host.say(text);
    }).catch(error => console.warn(`Quiz restart cleanup failed (${errorName(error)}).`));
  }
  results(limit = 10): { results: GameResult[] } {
    const n = Number.isInteger(limit) ? Math.min(30, Math.max(1, limit)) : 10;
    return { results: (this.data().results ?? []).slice(0, n) };
  }
  async menu(): Promise<void> {
    const last = this.data().results?.[0];
    const prev = last ? `\nPichla: ${last.title} · ${last.score !== undefined ? `${last.score}/${last.total}` : last.outcome}` : '';
    await this.host.panel(`Games 🎮${prev}\n\nQuiz, rapid fire, tic tac toe, hangman.\nCustom sawal Myra bhej sakti hai. Warna built-in set chalega.`, [
      [button('🧠 MCQ Quiz', 'g:quiz'), button('⚡ Rapid Fire', 'g:rapid')],
      [button('❌ Tic Tac Toe', 'g:ttt'), button('🔤 Hangman', 'g:hm')],
      [button('⏹ Band karo', 'g:stop')],
      ...BACK,
    ]);
  }
  async play(input: PlayInput): Promise<unknown> {
    if (input.kind === 'ttt') return this.enqueue(() => this.beginTtt(input.level ?? 'medium'));
    if (input.kind === 'hangman') return this.enqueue(() => this.beginHangman(input.word, input.hint));
    if (input.kind === 'quiz' || input.kind === 'rapid') return this.enqueue(() => this.beginQuiz(input));
    throw new GameError('Unknown game.');
  }
  async onPollAnswer(answer: IncomingPollAnswer): Promise<void> {
    const voter = answer.voter?.id ?? answer.user?.id;
    if (voter !== this.owner || !answer.poll_id) return;
    await this.enqueue(async () => {
      const game = this.data().active;
      if (!game || (game.kind !== 'quiz' && game.kind !== 'rapid') || game.pollId !== answer.poll_id || game.locked) return;
      game.locked = true; this.cancelTimer();
      const q = game.questions?.[game.index ?? 0];
      if (q && answer.option_ids?.[0] === q.answer) game.score = (game.score ?? 0) + 1;
      await this.save();
      await this.afterQuestion(game);
    });
  }
  async onCallback(cb: { id: string; from: { id: number }; data?: string }): Promise<void> {
    let answered = false;
    const toast: Toast = async text => {
      if (answered) return; answered = true;
      await this.host.call('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text: text.slice(0, 200) } : {}) }).catch(() => {});
    };
    try {
      if (cb.from.id !== this.owner) { await toast(); return; }
      const action = parseGameCallback(cb.data ?? '');
      if (!action) { await toast('Ye button purana hai'); return; }
      await this.enqueue(() => this.apply(action, toast));
    } finally { await toast(); }
  }

  private async apply(action: Action, toast: Toast): Promise<void> {
    if (action.type === 'menu') return this.menu();
    if (action.type === 'ttt-pick') return this.levels();
    if (action.type === 'stop') return this.stopVisible();
    if (action.type === 'end') { if (this.data().active?.id === action.id) await this.stopVisible(); else await toast('Ye game band ho chuka'); return; }
    if (action.type === 'move') return this.move(action.id, action.cell, toast);
    if (action.type === 'letter') return this.letter(action.id, action.letter, toast);
    await this.guard(async () => {
      if (action.type === 'quiz') await this.beginQuiz({ kind: 'quiz' });
      else if (action.type === 'rapid') await this.beginQuiz({ kind: 'rapid' });
      else if (action.type === 'ttt') await this.beginTtt(action.level);
      else if (action.type === 'hangman') await this.beginHangman();
    });
  }
  private async guard(work: () => Promise<unknown>): Promise<void> {
    try { await work(); }
    catch (error) {
      if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) throw error;
      await this.host.say(error instanceof GameError ? error.message : 'Game shuru nhi ho paya. Thodi der baad try karo.').catch(() => {});
    }
  }
  private async levels(): Promise<void> {
    await this.host.panel('Tic Tac Toe ❌⭕\n\nLevel chuno. Hard pe haraana mushkil hai.', [
      [button('Easy', 'g:te'), button('Medium', 'g:tm'), button('Hard', 'g:th')],
      [button('‹ Games', 'g:menu')],
    ]);
  }
  private async beginQuiz(input: PlayInput): Promise<{ started: true; kind: 'quiz' | 'rapid'; title: string; questions: number; timer_seconds: number; note: string }> {
    const kind = input.kind === 'rapid' ? 'rapid' : 'quiz';
    const questions = (input.questions?.length ? input.questions : kind === 'rapid' ? RAPID_BANK : QUIZ_BANK).map(checkQuestion);
    if (questions.length > 15) throw new GameError('At most 15 questions.');
    const timer = clampTimer(input.timer_seconds, kind === 'rapid' ? 10 : 20);
    const title = cleanTitle(input.title, kindLabel(kind));
    await this.stopQuiet();
    const game: ActiveGame = { id: this.newId(), kind, title, questions, index: 0, score: 0, timer };
    this.data().active = game;
    await this.save();
    try { await this.openQuiz(game); }
    catch (error) {
      this.cancelTimer(); delete this.data().active; await this.save().catch(() => {});
      if (error instanceof GameError || (error instanceof TelegramError && [401, 403, 409].includes(error.code))) throw error;
      throw new GameError('Quiz could not start. Check the questions and try again.');
    }
    return { started: true, kind, title, questions: questions.length, timer_seconds: timer, note: 'Game is running on Telegram. Do not repeat questions, options or answers.' };
  }
  private async openQuiz(game: ActiveGame): Promise<void> {
    game.statusId = await this.send(`${game.title}\nSawal 1/${game.questions!.length} · score 0\n${game.timer} sec`, [[{ text: '⏹ Band', callback_data: `g:x:${game.id}` }]]);
    await this.save();
    await this.sendPoll(game);
  }
  private async sendPoll(game: ActiveGame): Promise<void> {
    const q = game.questions![game.index!]!;
    const sent = await this.host.call('sendPoll', {
      question: `${game.index! + 1}/${game.questions!.length} · ${q.question}`.slice(0, 300),
      options: q.options.map(text => ({ text })), type: 'quiz', correct_option_id: q.answer, is_anonymous: false, open_period: game.timer,
      ...(q.explanation ? { explanation: q.explanation } : {}),
    }) as { message_id?: number; poll?: { id?: string } };
    if (!sent?.message_id || !sent.poll?.id) throw new GameError('Telegram did not start the quiz poll.');
    game.pollId = sent.poll.id; game.pollMessageId = sent.message_id; game.deadline = this.now() + game.timer! * 1000; game.locked = false;
    await this.save();
    this.arm(game);
  }
  private arm(game: ActiveGame): void {
    this.cancelTimer();
    const wait = Math.max(0, (game.deadline ?? this.now()) - this.now()) + 800;
    const id = game.id, index = game.index ?? 0;
    this.timer = (this.options.schedule ?? defaultSchedule)(wait, () => {
      void this.enqueue(() => this.expire(id, index)).catch(error => console.warn(`Quiz timer step failed (${errorName(error)}).`));
    });
  }
  private async expire(id: string, index: number): Promise<void> {
    const game = this.data().active;
    if (!game || game.id !== id || game.index !== index || game.locked) return;
    game.locked = true;
    if (game.pollMessageId) await this.host.call('stopPoll', { message_id: game.pollMessageId }).catch(() => {});
    await this.afterQuestion(game);
  }
  private async afterQuestion(game: ActiveGame): Promise<void> {
    if (this.data().active?.id !== game.id) return;
    await this.sleep(game.kind === 'rapid' ? 400 : 1500);
    if (this.data().active?.id !== game.id) return;
    game.index = (game.index ?? 0) + 1;
    if (game.index >= (game.questions?.length ?? 0)) return this.finishQuiz(game);
    game.locked = false;
    await this.save();
    try { await this.sendPoll(game); }
    catch (error) {
      // A quiz that cannot send its next poll is closed, never left half-open.
      if (this.data().active?.id === game.id) await this.record({ at: new Date().toISOString(), kind: game.kind, title: game.title || kindLabel(game.kind), outcome: 'stopped', score: game.score, total: game.questions?.length }).catch(() => {});
      const text = `Agla sawal nahi ja paya, quiz band.\nScore ${game.score ?? 0}/${game.questions?.length ?? 0}\n\n/games se phir shuru karo.`;
      if (game.statusId) await this.edit(game.statusId, text, endKeys(game.kind)).catch(() => this.host.say(text).catch(() => {}));
      else await this.host.say(text).catch(() => {});
      throw error;
    }
    await this.editStatus(game);
  }
  private async editStatus(game: ActiveGame): Promise<void> {
    if (!game.statusId) return;
    const text = `${game.title}\nSawal ${game.index! + 1}/${game.questions!.length} · score ${game.score ?? 0}\n${game.timer} sec`;
    await this.edit(game.statusId, text, [[{ text: '⏹ Band', callback_data: `g:x:${game.id}` }]]).catch(() => {});
  }
  private async finishQuiz(game: ActiveGame): Promise<void> {
    const score = game.score ?? 0, total = game.questions?.length ?? 0, title = game.title || kindLabel(game.kind), statusId = game.statusId;
    await this.record({ at: new Date().toISOString(), kind: game.kind, title, outcome: 'done', score, total });
    const text = `${title} khatam 🏆\n${score}/${total} sahi\n\n/games se ek aur, ya topic bolo.`;
    if (statusId) await this.edit(statusId, text, endKeys(game.kind)).catch(() => this.host.say(text));
    else await this.host.say(text);
  }
  private async beginTtt(level: Level): Promise<{ started: true; kind: 'ttt'; level: Level; note: string }> {
    if (level !== 'easy' && level !== 'medium' && level !== 'hard') throw new GameError('Level must be easy, medium or hard.');
    await this.stopQuiet();
    const game: ActiveGame = { id: this.newId(), kind: 'ttt', level, board: Array(9).fill(''), title: 'Tic Tac Toe' };
    this.data().active = game;
    try { game.boardId = await this.send(tttText(game), tttKeys(game)); await this.save(); }
    catch (error) { delete this.data().active; await this.save().catch(() => {}); throw error; }
    return { started: true, kind: 'ttt', level, note: 'Board is on Telegram. Owner plays X, bot plays O.' };
  }
  private async move(id: string, cell: number, toast: Toast): Promise<void> {
    const game = this.data().active;
    if (!game || game.kind !== 'ttt' || game.id !== id || !game.board || !game.boardId) { await toast('Ye game band ho chuka'); return; }
    if (winner(game.board)) { await toast('Game khatam'); return; }
    if (game.board[cell]) { await toast('Ye bhari hai'); return; }
    game.board[cell] = 'X';
    if (!winner(game.board)) { const i = botMove(game.board, game.level ?? 'medium', this.rng()); if (i >= 0) game.board[i] = 'O'; }
    const end = winner(game.board);
    if (end) {
      const outcome = end === 'X' ? 'won' : end === 'O' ? 'lost' : 'draw';
      const boardId = game.boardId, level = game.level, text = tttText(game);
      await this.record({ at: new Date().toISOString(), kind: 'ttt', title: 'Tic Tac Toe', outcome });
      await this.edit(boardId, text, endKeys('ttt', level)).catch(() => {});
      return;
    }
    await this.save();
    await this.edit(game.boardId, tttText(game), tttKeys(game));
  }
  private async beginHangman(word?: string, hint?: string): Promise<{ started: true; kind: 'hangman'; letters: number; hint: string; note: string }> {
    const picked = word ? { word: cleanWord(word), hint: hint?.replace(/\s+/g, ' ').trim().slice(0, 40) || 'word' } : this.pick(HANGMAN_BANK);
    await this.stopQuiet();
    const game: ActiveGame = { id: this.newId(), kind: 'hangman', word: picked.word, hint: picked.hint, guessed: [], title: 'Hangman' };
    this.data().active = game;
    try { game.boardId = await this.send(hangmanText(game), hangmanKeys(game)); await this.save(); }
    catch (error) { delete this.data().active; await this.save().catch(() => {}); throw error; }
    return { started: true, kind: 'hangman', letters: picked.word.length, hint: picked.hint, note: 'Board is on Telegram. Do not reveal the word.' };
  }
  private async letter(id: string, letter: string, toast: Toast): Promise<void> {
    const game = this.data().active;
    if (!game || game.kind !== 'hangman' || game.id !== id || !game.word || !game.boardId) { await toast('Ye game band ho chuka'); return; }
    if (game.guessed!.includes(letter)) { await toast('Ye try ho chuka'); return; }
    game.guessed!.push(letter);
    const view = hangmanView(game.word, game.guessed!);
    if (view.won || view.misses.length >= 6) {
      const boardId = game.boardId;
      const text = view.won ? `Hangman 🔤\n${view.shown}\n\nShabd mil gaya 🏆` : `Hangman 🔤\nShabd tha: ${game.word}\n\nIs baar nhi hua`;
      await this.record({ at: new Date().toISOString(), kind: 'hangman', title: 'Hangman', outcome: view.won ? 'won' : 'lost' });
      await this.edit(boardId, text, endKeys('hangman')).catch(() => {});
      return;
    }
    await this.save();
    await this.edit(game.boardId, hangmanText(game), hangmanKeys(game));
  }
  private async stopQuiet(): Promise<void> {
    const game = this.data().active;
    this.cancelTimer();
    if (!game) return;
    const pollMessageId = game.pollMessageId;
    delete this.data().active;
    await this.save();
    if (pollMessageId) await this.host.call('stopPoll', { message_id: pollMessageId }).catch(() => {});
  }
  private async stopVisible(): Promise<void> {
    const game = this.data().active;
    if (!game) return;
    const id = game.boardId ?? game.statusId, pollMessageId = game.pollMessageId;
    await this.record({ at: new Date().toISOString(), kind: game.kind, title: game.title || kindLabel(game.kind), outcome: 'stopped', ...(game.score !== undefined ? { score: game.score, total: game.questions?.length } : {}) });
    if (pollMessageId) await this.host.call('stopPoll', { message_id: pollMessageId }).catch(() => {});
    if (id) await this.edit(id, 'Game band.\n\n/games se ek aur.').catch(() => {});
  }
  private async record(result: GameResult): Promise<void> {
    this.cancelTimer();
    const data = this.data();
    data.results = [result, ...(data.results ?? [])].slice(0, 30);
    delete data.active;
    await this.save();
  }
  private async send(text: string, keyboard?: Buttons): Promise<number> {
    const sent = await this.host.call('sendMessage', { text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) }) as { message_id?: number };
    if (!sent?.message_id) throw new GameError('Telegram did not return a message id.');
    return sent.message_id;
  }
  private async edit(id: number, text: string, keyboard?: Buttons): Promise<void> {
    try { await this.host.call('editMessageText', { message_id: id, text, reply_markup: { inline_keyboard: keyboard ?? [] } }); }
    catch (error) { if (!(error instanceof TelegramError && error.unchanged)) throw error; }
  }
}
