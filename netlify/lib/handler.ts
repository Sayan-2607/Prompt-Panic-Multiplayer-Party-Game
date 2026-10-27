import { advance, applyAction, clean, codeFor, fail, GameError, hash, HEARTBEAT_MS, makeRoom, newPlayer, ROOM_TTL, snapshot } from './engine';
import type { Room, Player } from './engine';
import type { RoomStore } from './storage';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const codePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const secretPattern = /^[a-f0-9-]{64,100}$/i;
const key = (code: string) => `rooms/${code}`;
const expired = (room: Room, now: number) => room.closed || now - room.touched > ROOM_TTL;
const responseFor = (room: Room, player: Player, now: number, token?: string) => ({ ok: true, ...(token ? { token } : {}), state: snapshot(room, player, now) });
export type HandlerDeps = { store: RoomStore; now?: () => number; pause?: (ms: number) => Promise<void> };

export function createHandler({ store, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
    try {
      if (!['GET', 'POST'].includes(req.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (req.method === 'POST' && req.headers.get('origin') && req.headers.get('origin') !== new URL(req.url).origin) fail('Please use the game page to play.', 403);
      let data: Record<string, unknown> = {};
      if (req.method === 'POST') {
        if (!req.headers.get('content-type')?.startsWith('application/json')) fail('JSON required.', 415);
        if (Number(req.headers.get('content-length') || 0) > 8192) fail('Request too large.', 413);
        const raw = await req.text(); if (Buffer.byteLength(raw, 'utf8') > 8192) fail('Request too large.', 413);
        try { data = JSON.parse(raw); } catch { fail('Invalid JSON.'); }
        if (!data || Array.isArray(data) || typeof data !== 'object') fail('Invalid request.');
      }
      const action = req.method === 'GET' ? 'state' : clean(data.action, 16);
      if (action === 'create') {
        const name = clean(data.name, 24), secret = clean(data.sessionKey, 100);
        if (!name) fail('Enter a nickname first.');
        if (!secretPattern.test(secret)) fail('Invalid player session. Reload the page.');
        const secretHash = hash(secret), totalRounds = Number(data.totalRounds ?? 5);
        if (![3, 5].includes(totalRounds)) fail('Choose a three- or five-round game.');
        for (let attempt = 0; attempt < 8; attempt++) {
          const code = codeFor(secret, attempt), room = makeRoom(code, name, secretHash, totalRounds, now());
          const result = await store.write(key(code), room, { onlyIfNew: true });
          if (result.modified) return json(responseFor(room, room.players[0], now(), `${code}.${secret}`));
          const entry = await store.read(key(code));
          if (entry?.data.creationHash === secretHash) {
            const owner = entry.data.players.find(p => p.secretHash === secretHash);
            if (owner && !expired(entry.data, now())) return json(responseFor(entry.data, owner, now(), `${code}.${secret}`));
            fail('That room has closed. Start a new room.', 410);
          }
        }
        fail('Could not allocate a room code. Please try again.', 503);
      }
      let code: string, secret: string;
      if (action === 'join') {
        code = clean(data.code, 5).toUpperCase(); secret = clean(data.sessionKey, 100);
      } else {
        const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
        [code, secret] = token.split('.');
      }
      if (!codePattern.test(code || '') || !secretPattern.test(secret || '')) fail('Your player session is invalid. Please join again.', 401);
      const secretHash = hash(secret);
      const requestId = clean(data.requestId, 80);
      if (!['state', 'join'].includes(action) && !/^[a-f0-9-]{32,80}$/i.test(requestId)) fail('Missing action identifier. Reload the page.');
      const fingerprint = hash(JSON.stringify({ action, roundKey: data.roundKey, answer: data.answer, answerId: data.answerId, playerId: data.playerId }));
      // A room is one document: votes, scores, deadlines and receipts commit together.
      for (let attempt = 0; attempt < 10; attempt++) {
        const entry = await store.read(key(code));
        if (!entry || expired(entry.data, now())) fail(action === 'join' ? 'Room not found. Check the five-character code.' : 'Your room has expired. Please join again.', action === 'join' ? 404 : 410);
        const room = entry.data, time = now();
        let player = room.players.find(p => p.secretHash === secretHash);
        if (action !== 'join' && !player) fail('You are no longer in this room. Please join again.', 401);
        let changed = advance(room, time);
        let actionError: GameError | null = null;
        if (action === 'join') {
          if (!player) {
            const name = clean(data.name, 24);
            if (!name) fail('Enter a nickname first.');
            if (room.phase !== 'lobby') fail('This game has started. Join when the host starts a new lobby.');
            if (room.players.length >= 8) fail('This room is full (8 players).');
            if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) fail('That nickname is taken. Try another.');
            player = newPlayer(name, secretHash, time); room.players.push(player); changed = true;
          }
        }
        const me = player!;
        if (time - me.lastSeen >= HEARTBEAT_MS) { me.lastSeen = time; changed = true; }
        if (action !== 'state' && action !== 'join') {
          const receipt = room.receipts.find(r => r.id === requestId && r.playerId === me.id);
          if (receipt && receipt.fingerprint !== fingerprint) fail('This action identifier was already used.', 409);
          if (!receipt) {
            try {
              // A failed action must not leak partial mutations into a deadline commit.
              const working = structuredClone(room), actor = working.players.find(p => p.id === me.id)!;
              applyAction(working, actor, action, data, time);
              Object.assign(room, working);
              room.receipts.push({ id: requestId, playerId: me.id, fingerprint });
              room.receipts = room.receipts.slice(-256); changed = true;
            } catch (error) { if (error instanceof GameError) actionError = error; else throw error; }
          }
        }
        if (changed) {
          room.revision++; room.touched = time;
          const saved = await store.write(key(code), room, { onlyIfMatch: entry.etag });
          if (!saved.modified) { await pause(10 + attempt * 8 + Math.floor(Math.random() * 15)); continue; }
        }
        if (actionError) throw actionError;
        if (action === 'leave') return json({ ok: true });
        const updatedMe = room.players.find(p => p.secretHash === secretHash)!;
        return json(responseFor(room, updatedMe, time, action === 'join' ? `${code}.${secret}` : undefined));
      }
      return json({ error: 'The room is busy. Please try again.' }, 409);
    } catch (error) {
      if (error instanceof GameError) return json({ error: error.message }, error.status);
      console.error('Game function request failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: 'The game service is temporarily unavailable. Please try again.' }, 503);
    }
  };
}
