import test from 'node:test';
import assert from 'node:assert/strict';
import { Games, GameError, checkQuestion, cleanWord, empties, winner, botMove, hangmanView, parseGameCallback, type GamesData, type QuizQuestion } from '../src/games.js';
import { gameCallPayload, TelegramCallError } from '../src/telegram.js';

const OWNER = 4242;

function host() {
  const calls: { method: string; params: any }[] = [];
  let messageId = 100, pollId = 0;
  return {
    calls,
    sent: () => calls.filter(c => c.method === 'sendMessage'),
    polls: () => calls.filter(c => c.method === 'sendPoll'),
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === 'sendMessage') return { message_id: ++messageId };
      if (method === 'sendPoll') return { message_id: ++messageId, poll: { id: `poll-${++pollId}` } };
      return {};
    },
    async panel(_text: string, _buttons: unknown) { },
    async say(_text: string) { },
  };
}

function store() {
  const data: { games?: GamesData } = {};
  let saves = 0;
  return { data, saves: () => saves, save: async () => { saves++; } };
}

function make(options: Partial<ConstructorParameters<typeof Games>[3]> = {}) {
  const h = host(), s = store();
  const timers: { ms: number; fn: () => void }[] = [];
  const games = new Games(h as any, OWNER, s as any, {
    now: () => 1_000_000,
    sleep: async () => { },
    schedule: (ms, fn) => { timers.push({ ms, fn }); return { cancel: () => { } }; },
    newId: () => 'abcd',
    pick: (items: readonly any[]) => items[0],
    rng: () => 0,
    ...options,
  });
  return { games, h, s, timers };
}

const Q: QuizQuestion = { question: 'GST kab?', options: ['2016', '2017'], answer: 1 };

test('question validation keeps only usable quizzes', () => {
  assert.deepEqual(checkQuestion({ question: '  GST   kab? ', options: [' 2016 ', '2017'], answer: 1 }), { question: 'GST kab?', options: ['2016', '2017'], answer: 1 });
  assert.throws(() => checkQuestion({ question: '', options: ['a', 'b'], answer: 0 }), GameError);
  assert.throws(() => checkQuestion({ question: 'q', options: ['only'], answer: 0 }), GameError);
  assert.throws(() => checkQuestion({ question: 'q', options: ['a', 'a'], answer: 0 }), GameError);
  assert.throws(() => checkQuestion({ question: 'q', options: ['a', 'b'], answer: 2 }), GameError);
  assert.throws(() => checkQuestion({ question: 'q', options: ['a', 'b'], answer: -1 }), GameError);
  assert.throws(() => checkQuestion({ question: 'q', options: ['a', 'b'], answer: 1.5 }), GameError);
});

test('hangman word must be 3-12 plain letters', () => {
  assert.equal(cleanWord(' ledger '), 'LEDGER');
  assert.throws(() => cleanWord('ab'), GameError);
  assert.throws(() => cleanWord('two words'), GameError);
  assert.throws(() => cleanWord('LEDGER1'), GameError);
});

test('board helpers detect wins, draws and open cells', () => {
  assert.deepEqual(empties(['X', '', 'O', '', '', '', '', '', '']), [1, 3, 4, 5, 6, 7, 8]);
  assert.equal(winner(['X', 'X', 'X', '', '', '', '', '', '']), 'X');
  assert.equal(winner(['', '', '', 'O', 'O', 'O', '', '', '']), 'O');
  assert.equal(winner(['X', '', '', '', 'X', '', '', '', 'X']), 'X');
  assert.equal(winner(['X', 'O', 'X', 'O', 'X', 'O', 'O', 'X', 'O']), 'draw');
  assert.equal(winner(['', '', '', '', '', '', '', '', '']), '');
});

test('bot plays a win, blocks a threat and keeps hard level sharp', () => {
  const win = ['O', 'O', '', '', 'X', '', '', 'X', ''];
  assert.equal(botMove(win, 'easy', () => 0), 2);
  const block = ['X', 'X', '', '', 'O', '', '', 'O', ''];
  assert.equal(botMove(block, 'medium', () => 0), 2);
  assert.equal(botMove(['X', '', 'O', '', '', '', '', '', ''], 'medium', () => 0), 4);
  // Hard forks with a corner instead of taking the centre.
  const fork = botMove(['X', '', '', '', '', '', '', '', 'O'], 'hard', () => 0);
  assert.ok(fork === 2 || fork === 6, `hard level should fork, got ${fork}`);
  assert.equal(botMove(['X', '', '', '', '', '', '', '', 'O'], 'medium', () => 0), 4, 'medium takes the centre');
  assert.equal(botMove(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X'], 'hard', () => 0), -1);
});

test('hangman view shows guessed letters and counts misses', () => {
  const view = hangmanView('LEDGER', ['L', 'Z']);
  assert.equal(view.shown, 'L _ _ _ _ _');
  assert.equal(view.won, false);
  assert.deepEqual(view.misses, ['Z']);
  assert.equal(hangmanView('LEDGER', ['L', 'E', 'D', 'G', 'R']).won, true);
});

test('callback data is parsed strictly and only for known actions', () => {
  assert.deepEqual(parseGameCallback('g:menu'), { type: 'menu' });
  assert.deepEqual(parseGameCallback('g:quiz'), { type: 'quiz' });
  assert.deepEqual(parseGameCallback('g:rapid'), { type: 'rapid' });
  assert.deepEqual(parseGameCallback('g:ttt'), { type: 'ttt-pick' });
  assert.deepEqual(parseGameCallback('g:th'), { type: 'ttt', level: 'hard' });
  assert.deepEqual(parseGameCallback('g:hm'), { type: 'hangman' });
  assert.deepEqual(parseGameCallback('g:stop'), { type: 'stop' });
  assert.deepEqual(parseGameCallback('g:m:abcd:4'), { type: 'move', id: 'abcd', cell: 4 });
  assert.deepEqual(parseGameCallback('g:l:abcd:A'), { type: 'letter', id: 'abcd', letter: 'A' });
  assert.deepEqual(parseGameCallback('g:x:abcd'), { type: 'end', id: 'abcd' });
  assert.equal(parseGameCallback('g:unknown'), undefined);
  assert.equal(parseGameCallback('menu'), undefined);
  assert.equal(parseGameCallback('g:m:abcd:9'), undefined);
  assert.equal(parseGameCallback('g:l:abcd:AB'), undefined);
});

test('game API refuses anything that is not a game', () => {
  assert.throws(() => gameCallPayload('sendPhoto', {}, OWNER, []), TelegramCallError);
  assert.throws(() => gameCallPayload('sendMessage', { inline_message_id: 'x' }, OWNER, []), TelegramCallError);
  assert.throws(() => gameCallPayload('sendPoll', { type: 'regular' }, OWNER, []), TelegramCallError);
  assert.throws(() => gameCallPayload('sendPoll', { type: 'quiz', open_period: 2 }, OWNER, []), TelegramCallError);
  assert.throws(() => gameCallPayload('sendPoll', { type: 'quiz', open_period: 601 }, OWNER, []), TelegramCallError);
  assert.throws(() => gameCallPayload('sendMessage', { reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'bad' }]] } }, OWNER, []), TelegramCallError);
  assert.throws(() => gameCallPayload('sendMessage', { reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'g:menu', url: 'https://x' }]] } }, OWNER, []), TelegramCallError);
  const poll = gameCallPayload('sendPoll', { type: 'quiz', open_period: 30 }, OWNER, []);
  assert.equal(poll.chat_id, OWNER);
  assert.equal(poll.is_anonymous, false);
  const acq = gameCallPayload('answerCallbackQuery', { callback_query_id: '1' }, OWNER, []);
  assert.equal(acq.chat_id, undefined);
});

test('quiz sends a telegram poll, scores the answer and ends with a result', async () => {
  const { games, h, s } = make();
  await games.play({ kind: 'quiz', title: 'GST quiz', questions: [Q, { question: 'PAN?', options: ['10', '12'], answer: 0 }], timer_seconds: 15 });
  assert.equal(h.polls().length, 1);
  const poll = h.polls()[0]!.params;
  assert.equal(poll.type, 'quiz');
  assert.equal(poll.open_period, 15);
  assert.equal(poll.correct_option_id, 1);
  assert.equal(poll.is_anonymous, false);
  const pollId = (h.polls()[0]!.params ? 'poll-1' : '');
  await games.onPollAnswer({ poll_id: pollId, option_ids: [1], voter: { id: OWNER } });
  assert.equal(s.data.games?.active?.score, 1);
  assert.equal(h.polls().length, 2, 'next question is sent after a correct answer');
  await games.onPollAnswer({ poll_id: 'poll-2', option_ids: [1], voter: { id: OWNER } });
  assert.equal(s.data.games?.active, undefined, 'the game closes after the last question');
  const results = games.results();
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0]!.score, 1, 'only the correct answer scores');
  assert.equal(results.results[0]!.total, 2);
  assert.equal(results.results[0]!.outcome, 'done');
});

test('only the owner can answer and only the running poll counts', async () => {
  const { games, h, s } = make();
  await games.play({ kind: 'quiz', questions: [Q, { question: '2+2?', options: ['3', '4'], answer: 1 }], timer_seconds: 10 });
  await games.onPollAnswer({ poll_id: 'poll-1', option_ids: [1], voter: { id: 999 } });
  assert.equal(s.data.games?.active?.score, 0, 'another user cannot score');
  await games.onPollAnswer({ poll_id: 'wrong-poll', option_ids: [1], voter: { id: OWNER } });
  assert.equal(s.data.games?.active?.score, 0);
  await games.onPollAnswer({ poll_id: 'poll-1', option_ids: [1], user: { id: OWNER } });
  assert.equal(s.data.games?.active?.score, 1);
  assert.equal(h.polls().length, 2);
});

test('a wrong answer still advances the quiz', async () => {
  const { games, s } = make();
  await games.play({ kind: 'rapid', questions: [Q, { question: '2+2?', options: ['3', '4'], answer: 1 }], timer_seconds: 10 });
  await games.onPollAnswer({ poll_id: 'poll-1', option_ids: [0], voter: { id: OWNER } });
  assert.equal(s.data.games?.active?.score, 0);
  assert.equal(s.data.games?.active?.index, 1);
});

test('timer that runs out moves to the next question without a score', async () => {
  const { games, h, s, timers } = make();
  await games.play({ kind: 'quiz', questions: [Q, { question: '2+2?', options: ['3', '4'], answer: 1 }], timer_seconds: 10 });
  timers.at(-1)!.fn();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(s.data.games?.active?.index, 1);
  assert.equal(s.data.games?.active?.score, 0);
  assert.equal(h.polls().length, 2);
  assert.ok(h.calls.some(c => c.method === 'stopPoll'), 'the expired poll is closed');
});

test('tic tac toe: owner moves, bot answers and the result is recorded', async () => {
  const { games, h, s } = make();
  await games.play({ kind: 'ttt', level: 'medium' });
  await games.onCallback({ id: 'c1', from: { id: OWNER }, data: 'g:m:abcd:0' });
  const board = s.data.games?.active?.board;
  assert.equal(board?.[0], 'X');
  assert.ok(board?.filter(Boolean).length === 2, 'the bot answered');
  await games.onCallback({ id: 'c2', from: { id: OWNER }, data: 'g:m:abcd:0' });
  assert.equal(s.data.games?.active?.board?.[0], 'X', 'a filled cell is not overwritten');
  const edits = h.calls.filter(c => c.method === 'editMessageText');
  assert.ok(edits.length >= 1);
});

test('tic tac toe from another user is ignored', async () => {
  const { games, s } = make();
  await games.play({ kind: 'ttt', level: 'easy' });
  await games.onCallback({ id: 'c1', from: { id: 999 }, data: 'g:m:abcd:0' });
  assert.equal(s.data.games?.active?.board?.[0], '', 'the board stays empty');
});

test('hangman: letters reveal the word and the result is stored', async () => {
  const { games, s } = make();
  await games.play({ kind: 'hangman', word: 'ledger', hint: 'accounts ki kitab' });
  assert.equal(s.data.games?.active?.word, 'LEDGER');
  for (const letter of ['L', 'E', 'D', 'G', 'R']) await games.onCallback({ id: 'c', from: { id: OWNER }, data: `g:l:abcd:${letter}` });
  const results = games.results();
  assert.equal(results.results[0]!.outcome, 'won');
  assert.equal(results.results[0]!.kind, 'hangman');
});

test('hangman ends after six wrong letters', async () => {
  const { games, s } = make();
  await games.play({ kind: 'hangman', word: 'LEDGER' });
  for (const letter of ['A', 'B', 'C', 'F', 'H', 'J']) await games.onCallback({ id: 'c', from: { id: OWNER }, data: `g:l:abcd:${letter}` });
  assert.equal(games.results().results[0]!.outcome, 'lost');
});

test('stopping a game records the stop and frees the board', async () => {
  const { games, s } = make();
  await games.play({ kind: 'ttt', level: 'hard' });
  await games.onCallback({ id: 'c', from: { id: OWNER }, data: 'g:x:abcd' });
  assert.equal(s.data.games?.active, undefined);
  assert.equal(games.results().results[0]!.outcome, 'stopped');
});

test('an invalid timer and a bad level are refused', async () => {
  const { games } = make();
  await assert.rejects(() => games.play({ kind: 'quiz', questions: [Q], timer_seconds: 2 }), GameError);
  await assert.rejects(() => games.play({ kind: 'quiz', questions: [Q], timer_seconds: 700 }), GameError);
  await assert.rejects(() => games.play({ kind: 'quiz', questions: Array(16).fill(Q) }), GameError);
});

test('a restarted bot closes an open quiz instead of pretending it still runs', async () => {
  const { games, h, s } = make();
  await games.play({ kind: 'quiz', questions: [Q], timer_seconds: 10 });
  games.restore();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(h.calls.some(c => c.method === 'stopPoll'));
  assert.equal(s.data.games?.active, undefined);
  assert.equal(games.results().results[0]!.outcome, 'stopped');
});
