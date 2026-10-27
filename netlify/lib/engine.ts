import { createHash, randomInt, randomUUID } from 'node:crypto';
import { prompts } from './prompts';

export type Phase = 'lobby' | 'answer' | 'vote' | 'results' | 'finished';
export type Player = { id: string; secretHash: string; name: string; score: number; lastSeen: number };
export type Option = { id: string; owner: string | null; text: string };
export type Receipt = { id: string; playerId: string; fingerprint: string };
export type Room = {
  schema: 1; code: string; creationHash: string; gameId: string; revision: number;
  phase: Phase; round: number; totalRounds: number; deadline: number | null; hostId: string;
  createdAt: number; touched: number; closed: boolean; players: Player[]; deck: number[];
  promptIndex: number | null; answers: Record<string, string>; votes: Record<string, string>;
  gains: Record<string, number>; options: Option[]; receipts: Receipt[];
};
export const ANSWER_MS = 45000, VOTE_MS = 20000, RESULT_MS = 8000;
export const CONNECTED_MS = 15000, HEARTBEAT_MS = 5000, ROOM_TTL = 6 * 60 * 60 * 1000;
export const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export class GameError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function fail(message: string, status = 400): never { throw new GameError(message, status); }
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
export const connected = (p: Player, now: number) => now - p.lastSeen < CONNECTED_MS;
export const roundKey = (room: Room) => `${room.gameId}:${room.round}`;
export function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function codeFor(secret: string, attempt: number): string {
  const bytes = createHash('sha256').update(`prompt-panic:${attempt}:${secret}`).digest();
  return Array.from(bytes.subarray(0, 5), n => alphabet[n % alphabet.length]).join('');
}
export function newPlayer(name: string, secretHash: string, now: number): Player {
  return { id: randomUUID(), secretHash, name, score: 0, lastSeen: now };
}
export function makeRoom(code: string, name: string, secretHash: string, totalRounds: number, now: number): Room {
  const player = newPlayer(name, secretHash, now);
  return { schema: 1, code, creationHash: secretHash, gameId: randomUUID(), revision: 1,
    phase: 'lobby', round: 0, totalRounds, deadline: null, hostId: player.id,
    createdAt: now, touched: now, closed: false, players: [player], deck: shuffle(prompts.map((_, i) => i)),
    promptIndex: null, answers: {}, votes: {}, gains: {}, options: [], receipts: [] };
}
function startRound(room: Room, now: number) {
  room.round++; room.phase = 'answer'; room.promptIndex = room.deck[(room.round - 1) % room.deck.length];
  room.answers = {}; room.votes = {}; room.gains = {}; room.options = []; room.deadline = now + ANSWER_MS;
}
function openVoting(room: Room, now: number) {
  room.options = Object.entries(room.answers).map(([owner, text]) => ({ id: randomUUID(), owner, text }));
  if (room.players.length === 2 || room.options.length < 2) room.options.push({ id: randomUUID(), owner: null, text: prompts[room.promptIndex!].house });
  room.options = shuffle(room.options); room.phase = 'vote'; room.deadline = now + VOTE_MS;
}
function scoreRound(room: Room, now: number) {
  room.gains = {};
  for (const id of Object.values(room.votes)) {
    const owner = room.options.find(option => option.id === id)?.owner;
    if (owner) room.gains[owner] = (room.gains[owner] || 0) + 100;
  }
  for (const player of room.players) player.score += room.gains[player.id] || 0;
  room.phase = 'results'; room.deadline = now + RESULT_MS;
}
function nextRound(room: Room, now: number) {
  const high = Math.max(...room.players.map(p => p.score));
  const tied = room.players.filter(p => p.score === high).length > 1;
  if (room.round >= room.totalRounds + 1 || (room.round >= room.totalRounds && !tied)) {
    room.phase = 'finished'; room.deadline = null;
  } else startRound(room, now);
}
// Every invocation advances elapsed deadlines. No timers or background processes exist.
export function advance(room: Room, now: number): boolean {
  let changed = false;
  for (let i = 0; room.deadline !== null && now >= room.deadline && i < 32; i++) {
    const due = room.deadline;
    if (room.phase === 'answer') openVoting(room, due);
    else if (room.phase === 'vote') scoreRound(room, due);
    else if (room.phase === 'results') nextRound(room, due);
    else break;
    changed = true;
  }
  const host = room.players.find(p => p.id === room.hostId);
  if (!host || !connected(host, now)) {
    const replacement = room.players.find(p => connected(p, now));
    if (replacement && replacement.id !== room.hostId) { room.hostId = replacement.id; changed = true; }
  }
  return changed;
}
export function applyAction(room: Room, player: Player, action: string, data: Record<string, unknown>, now: number) {
  if (['start', 'next', 'replay', 'remove'].includes(action) && player.id !== room.hostId) fail('Only the host can do that.', 403);
  if (['start', 'next', 'replay', 'answer', 'vote'].includes(action) && data.roundKey !== roundKey(room)) fail('The round has changed. Please try again.', 409);
  if (action === 'start') {
    if (room.phase !== 'lobby') fail('The game has already started.');
    if (room.players.length < 2 || room.players.filter(p => connected(p, now)).length < 2) fail('At least two connected players are needed.');
    startRound(room, now);
  } else if (action === 'answer') {
    if (room.phase !== 'answer') fail('This answer round has closed.');
    const answer = clean(data.answer, 160); if (!answer) fail('Write an answer first.');
    if (room.answers[player.id]) fail('Your answer is already locked in.');
    room.answers[player.id] = answer;
    if (Object.keys(room.answers).length === room.players.length) openVoting(room, now);
  } else if (action === 'vote') {
    if (room.phase !== 'vote') fail('Voting has closed.');
    const option = room.options.find(o => o.id === data.answerId);
    if (!option) fail('Choose one of the answers.');
    if (option.owner === player.id) fail('You cannot vote for yourself.');
    if (room.votes[player.id]) fail('You have already voted.');
    room.votes[player.id] = option.id;
    if (Object.keys(room.votes).length === room.players.length) scoreRound(room, now);
  } else if (action === 'next') {
    if (room.phase !== 'results') fail('Wait for the round results.'); nextRound(room, now);
  } else if (action === 'replay') {
    if (room.phase !== 'finished') fail('Finish this game first.');
    room.gameId = randomUUID(); room.phase = 'lobby'; room.round = 0; room.deadline = null; room.promptIndex = null;
    room.answers = {}; room.votes = {}; room.gains = {}; room.options = [];
    room.deck = shuffle(prompts.map((_, i) => i)); room.players.forEach(p => p.score = 0);
  } else if (action === 'remove') {
    if (room.phase !== 'lobby') fail('Players can only be removed in the lobby.');
    const target = room.players.find(p => p.id === data.playerId);
    if (!target || target.id === player.id) fail('Choose another player.');
    room.players = room.players.filter(p => p !== target);
  } else if (action === 'leave') {
    if (!['lobby', 'finished'].includes(room.phase)) fail('You can leave after the game. Closing the tab keeps your seat for reconnecting.');
    room.players = room.players.filter(p => p !== player);
    if (room.hostId === player.id) room.hostId = room.players[0]?.id || '';
    if (!room.players.length) room.closed = true;
  } else fail('Unknown action.', 404);
}
export function snapshot(room: Room, me: Player, now: number) {
  const reveal = room.phase === 'results' || room.phase === 'finished';
  const high = Math.max(...room.players.map(p => p.score));
  return {
    code: room.code, phase: room.phase, round: room.round, totalRounds: room.totalRounds, maxRounds: room.totalRounds + 1,
    roundKey: roundKey(room), revision: room.revision, deadline: room.deadline, serverTime: now,
    hostId: room.hostId, prompt: room.promptIndex === null ? '' : prompts[room.promptIndex].text,
    houseMode: room.players.length === 2,
    me: { id: me.id, answer: room.answers[me.id] || '', voted: Boolean(room.votes[me.id]) },
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: connected(p, now),
      submitted: Boolean(room.answers[p.id]), voted: Boolean(room.votes[p.id]), gained: room.gains[p.id] || 0 })),
    answers: room.phase === 'lobby' || room.phase === 'answer' ? [] : room.options.map(o => ({ id: o.id, text: o.text, mine: o.owner === me.id,
      ...(reveal ? { author: room.players.find(p => p.id === o.owner)?.name || 'The house', owner: o.owner,
        votes: Object.values(room.votes).filter(v => v === o.id).length } : {}) })),
    winners: room.phase === 'finished' ? room.players.filter(p => p.score === high).map(p => p.id) : []
  };
}
