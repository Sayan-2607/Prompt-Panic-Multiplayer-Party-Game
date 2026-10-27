import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Room } from '../netlify/lib/engine';
import type { RoomStore, RoomEntry } from '../netlify/lib/storage';
export type WebHandler = (req: Request) => Promise<Response>;
export const secret = () => randomUUID() + randomUUID();
export const endpoint = 'https://game.example/.netlify/functions/game';
export function client(handler: WebHandler) {
  return {
    async post(action: string, data: Record<string, unknown> = {}, token?: string, expected = 200, requestId = randomUUID()) {
      const response = await handler(new Request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ action, requestId, ...data }) }));
      const result = await response.json(); assert.equal(response.status, expected, `${action}: ${JSON.stringify(result)}`); return result;
    },
    async state(token: string, expected = 200) {
      const response = await handler(new Request(endpoint, { headers: { Authorization: 'Bearer ' + token } }));
      const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result));
      assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0'); return result;
    }
  };
}
export class AtomicMemoryStore implements RoomStore {
  entries = new Map<string, RoomEntry>(); conflicts = 0; writes = 0;
  async read(key: string) { await new Promise(resolve => setImmediate(resolve)); return structuredClone(this.entries.get(key) || null); }
  async write(key: string, data: Room, condition: { onlyIfNew: true } | { onlyIfMatch: string }) {
    await new Promise(resolve => setImmediate(resolve));
    const current = this.entries.get(key);
    if (('onlyIfNew' in condition && current) || ('onlyIfMatch' in condition && current?.etag !== condition.onlyIfMatch)) { this.conflicts++; return { modified: false }; }
    this.writes++; this.entries.set(key, { data: structuredClone(data), etag: '"' + this.writes + '"' }); return { modified: true };
  }
}
export async function completeThreeRoundGame(handler: WebHandler) {
  const api = client(handler);
  const host = await api.post('create', { name: 'Alex', totalRounds: 3, sessionKey: secret() });
  const guest = await api.post('join', { name: 'Sam', code: host.state.code, sessionKey: secret() });
  assert.equal(host.state.totalRounds, 3);
  assert.equal((await api.state(host.token)).state.players.length, 2);
  let result = await api.post('start', { roundKey: host.state.roundKey }, host.token);
  const rounds: Array<{ round: number; scores: number[] }> = [];
  for (let round = 1; round <= 3; round++) {
    assert.equal(result.state.phase, 'answer'); assert.equal(result.state.round, round);
    const roundKey = result.state.roundKey;
    await api.post('answer', { answer: 'Alex answer ' + round, roundKey }, host.token);
    const beforeReveal = await api.state(guest.token); assert.deepEqual(beforeReveal.state.answers, []);
    result = await api.post('answer', { answer: 'Sam answer ' + round, roundKey }, guest.token);
    assert.equal(result.state.phase, 'vote'); assert.equal(result.state.answers.length, 3);
    assert.ok(result.state.answers.every((a: any) => !('owner' in a) && !('author' in a) && !('votes' in a)));
    const options = result.state.answers;
    const hostAnswer = options.find((a: any) => a.text === 'Alex answer ' + round).id;
    const guestAnswer = options.find((a: any) => a.text === 'Sam answer ' + round).id;
    const houseAnswer = options.find((a: any) => a.id !== hostAnswer && a.id !== guestAnswer).id;
    await api.post('vote', { answerId: hostAnswer, roundKey }, host.token, 400);
    const firstVoteId = randomUUID();
    await api.post('vote', { answerId: round === 1 ? guestAnswer : houseAnswer, roundKey }, host.token, 200, firstVoteId);
    // Same request may arrive twice after a lost response; it remains one vote.
    await api.post('vote', { answerId: round === 1 ? guestAnswer : houseAnswer, roundKey }, host.token, 200, firstVoteId);
    result = await api.post('vote', { answerId: round === 3 ? houseAnswer : hostAnswer, roundKey }, guest.token);
    assert.equal(result.state.phase, 'results');
    const scores = result.state.players.map((p: any) => p.score);
    assert.deepEqual(scores, round === 1 ? [100, 100] : [200, 100]);
    rounds.push({ round, scores });
    const otherScreen = await api.state(host.token); assert.deepEqual(otherScreen.state.players.map((p: any) => p.score), scores);
    result = await api.post('next', { roundKey }, host.token);
  }
  assert.equal(result.state.phase, 'finished'); assert.equal(result.state.round, 3);
  assert.deepEqual(result.state.winners, [host.state.me.id]);
  assert.equal((await api.state(guest.token)).state.winners[0], host.state.me.id);
  return { rounds, winner: 'Alex', finalScores: [200, 100], host, guest, final: result };
}
