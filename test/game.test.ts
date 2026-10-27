import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../netlify/lib/handler';
import { client, AtomicMemoryStore, secret, completeThreeRoundGame, endpoint } from './helpers';

function setup() {
  let time = Date.now(); const store = new AtomicMemoryStore();
  const handler = createHandler({ store, now: () => time, pause: async () => {} });
  return { handler, store, api: client(handler), advance(ms: number) { time += ms; } };
}
test('complete three-round game: two players, 100/100 → 200/100 → Alex wins; replay', async () => {
  const g = setup(); const played = await completeThreeRoundGame(g.handler);
  const replay = await g.api.post('replay', { roundKey: played.final.state.roundKey }, played.host.token);
  assert.equal(replay.state.phase, 'lobby'); assert.equal(replay.state.totalRounds, 3);
  assert.ok(replay.state.players.every((p: any) => p.score === 0));
});
test('eight concurrent joins, answers and votes are retained after conditional-write conflicts', async () => {
  const g = setup();
  const host = await g.api.post('create', { name: 'Host', sessionKey: secret() });
  const guests = await Promise.all(Array.from({length:7}, (_, i) => g.api.post('join', { name: 'Guest ' + i, code: host.state.code, sessionKey: secret() })));
  const players = [host, ...guests];
  assert.equal((await g.api.state(host.token)).state.players.length, 8);
  await g.api.post('join', { name: 'Ninth', code: host.state.code, sessionKey: secret() }, undefined, 400);
  const start = await g.api.post('start', { roundKey: host.state.roundKey }, host.token);
  const roundKey = start.state.roundKey;
  await Promise.all(players.map((p, i) => g.api.post('answer', { answer: 'Answer ' + i, roundKey }, p.token)));
  const voting = (await g.api.state(host.token)).state; assert.equal(voting.phase, 'vote'); assert.equal(voting.answers.length, 8);
  await Promise.all(players.map((p, i) => g.api.post('vote', { answerId: voting.answers.find((a: any) => a.text === 'Answer ' + ((i+1)%8)).id, roundKey }, p.token)));
  const scored = (await g.api.state(host.token)).state;
  assert.equal(scored.phase, 'results'); assert.ok(scored.players.every((p: any) => p.score === 100));
  assert.ok(g.store.conflicts > 0, 'The test must actually exercise CAS retries.');
});
test('deadlines are advanced on invocation, with missed answers/votes and no double-scoring', async () => {
  const g = setup();
  const a = await g.api.post('create', {name:'Alex',sessionKey:secret()});
  const b = await g.api.post('join',{name:'Sam',code:a.state.code,sessionKey:secret()});
  const start=await g.api.post('start',{roundKey:a.state.roundKey},a.token); const roundKey=start.state.roundKey;
  await g.api.post('answer',{answer:'A timely answer',roundKey},a.token);
  g.advance(45001); let current=(await g.api.state(b.token)).state; assert.equal(current.phase,'vote');
  await g.api.post('answer',{answer:'Late',roundKey},b.token,400);
  await g.api.post('vote',{answerId:current.answers.find((a:any)=>a.text==='A timely answer').id,roundKey},b.token);
  g.advance(20000); current=(await g.api.state(a.token)).state;
  assert.equal(current.phase,'results'); assert.equal(current.players[0].score,100);
  assert.equal((await g.api.state(a.token)).state.players[0].score,100);
  g.advance(8000); assert.equal((await g.api.state(b.token)).state.round,2);
  await g.api.post('answer',{answer:'Stale round',roundKey},b.token,409);
});
test('classic five rounds is the default; ties get exactly one extra round then shared victory', async () => {
  const g=setup(); const a=await g.api.post('create',{name:'Alex',sessionKey:secret()});
  const b=await g.api.post('join',{name:'Sam',code:a.state.code,sessionKey:secret()});
  assert.equal(a.state.totalRounds,5);
  let s=(await g.api.post('start',{roundKey:a.state.roundKey},a.token)).state;
  for(let r=1;r<=6;r++) {
    assert.equal(s.round,r);
    g.advance(45000); s=(await g.api.state(a.token)).state; assert.equal(s.phase,'vote');
    g.advance(20000); s=(await g.api.state(b.token)).state; assert.equal(s.phase,'results');
    g.advance(8000); s=(await g.api.state(a.token)).state;
  }
  assert.equal(s.phase,'finished'); assert.equal(s.winners.length,2);
});
test('idempotent create/join, authorization, removal, host transfer, and expiry', async () => {
  const g=setup(), key=secret();
  const a=await g.api.post('create',{name:'Alex',sessionKey:key});
  const repeat=await g.api.post('create',{name:'Alex',sessionKey:key}); assert.equal(a.token,repeat.token);
  const sk=secret(), b=await g.api.post('join',{name:'Sam',code:a.state.code,sessionKey:sk});
  const joinedAgain=await g.api.post('join',{name:'Sam',code:a.state.code,sessionKey:sk}); assert.equal(b.state.me.id,joinedAgain.state.me.id);
  await g.api.post('join',{name:'sam',code:a.state.code,sessionKey:secret()},undefined,400);
  await g.api.post('start',{roundKey:a.state.roundKey},b.token,403);
  await g.api.state(`${a.state.code}.${secret()}`,401);
  g.advance(11000); await g.api.state(b.token); g.advance(5000);
  const s=(await g.api.state(b.token)).state; assert.equal(s.hostId,b.state.me.id);
  await g.api.post('remove',{playerId:a.state.me.id},b.token); await g.api.state(a.token,401);
  g.advance(6*60*60*1000+1); await g.api.state(b.token,410);
});
test('input guards: method, origin, request size and round count', async () => {
  const g=setup();
  assert.equal((await g.handler(new Request(endpoint,{method:'DELETE'}))).status,405);
  assert.equal((await g.handler(new Request(endpoint,{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'}))).status,403);
  await g.api.post('create',{name:'Alex',sessionKey:secret(),totalRounds:99},undefined,400);
  const res=await g.handler(new Request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({big:'x'.repeat(9000)})}));
  assert.equal(res.status,413);
});
