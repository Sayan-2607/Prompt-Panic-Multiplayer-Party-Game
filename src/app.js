const $ = s => document.querySelector(s);
const app = $('#app');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const readSaved = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const save = (key, value) => { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {} };
let token = readSaved('pp-token'), state = null, pollTimer, pollEpoch = 0, stageKey = '', clockOffset = 0, toastTimer, pending = false;
let entryMode = new URLSearchParams(location.search).has('room') ? 'join' : 'create';
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5000); }
const ENDPOINT = '/.netlify/functions/game';
function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

function acceptState(incoming) {
  if (!incoming || (state && incoming.code === state.code && incoming.revision < state.revision)) return;
  state = incoming; clockOffset = incoming.serverTime - Date.now(); render();
}
async function request(method, payload, sessionToken = token) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(ENDPOINT, {
      method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), cache: 'no-store', signal: controller.signal
    });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The game service is not available yet. Please try again shortly.');
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Please try again.'), { status: response.status });
    return result;
  } finally { clearTimeout(timeout); }
}
async function api(action, data = {}) {
  const sessionToken = token;
  const payload = { ...data, action, requestId: newId() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await request('POST', payload, sessionToken);
      if (!['create','join','leave'].includes(action) && token === sessionToken && state) acceptState(result.state);
      return result;
    } catch (error) {
      // Retrying the same action identifier is safe even if the first response was lost.
      if (attempt === 1 || (error.status && error.status < 500)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
function landing() {
  stageKey = '';
  app.innerHTML = `<div class="landing"><section class="intro"><div class="eyebrow"><span class="live-dot"></span> YOUR NEXT GAME NIGHT STARTS HERE</div><h1>Small prompts.<br>Big <span class="scribble">personalities.</span></h1><p class="lede">Think fast. Write something ridiculous.<br>Let your friends decide who’s funniest.</p><div class="sample"><div class="sample-label">A LITTLE TASTE OF THE CHAOS <span>↗</span></div><p>“The least useful<br>superpower.”</p><span class="sample-answer">Knowing when toast feels lonely.</span><span class="sample-star" aria-hidden="true">✳</span></div><div class="quick-facts"><span>↗ No downloads</span><span>◎ Every phone is a controller</span></div></section><section class="entry card"><span class="pill">LET’S GET EVERYONE IN</span><h2>Bring your people.</h2><p>One room. Up to eight questionable senses of humour.</p><div class="tabs" aria-label="Room action"><button type="button" data-mode="create" aria-pressed="${entryMode === 'create'}" class="${entryMode === 'create' ? 'active' : ''}">Create a room</button><button type="button" data-mode="join" aria-pressed="${entryMode === 'join'}" class="${entryMode === 'join' ? 'active' : ''}">Join a room</button></div><form id="entry-form"><label for="nickname">YOUR NICKNAME</label><input id="nickname" name="name" maxlength="24" required autocomplete="nickname" placeholder="What should we call you?" value="${escapeHtml(readSaved('pp-name') || '')}">${entryMode === 'join' ? `<label for="room-code">ROOM CODE</label><input id="room-code" name="code" class="code-input" maxlength="5" minlength="5" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE" value="${escapeHtml(new URLSearchParams(location.search).get('room') || '')}">` : '<label for="round-count">GAME LENGTH</label><select id="round-count" name="totalRounds"><option value="5" selected>5 rounds · Classic game</option><option value="3">3 rounds · Quick game</option></select>'}<button class="primary wide" type="submit">${entryMode === 'create' ? 'Start the party' : 'Join the party'} <span>↗</span></button><p id="entry-error" class="error" role="alert"></p></form><div class="entry-foot">${entryMode === 'create' ? 'You’ll get a room code to share with your friends.' : 'Get the five-character code from your host.'}</div></section></div><section class="how"><div class="how-title">THE PLAN IS SIMPLE<span>Creativity optional. Participation encouraged.</span></div><div><b>01</b><strong>Write something.</strong><p>45 seconds. One silly prompt.</p></div><div><b>02</b><strong>Pick a favourite.</strong><p>Anonymous answers. No self-votes.</p></div><div><b>03</b><strong>Claim the glory.</strong><p>100 points per vote. Your kind of glory.</p></div></section>`;
}
function resetSession(message) { clearTimeout(pollTimer); pollEpoch++; token = null; state = null; save('pp-token', null); $('#connection').hidden = true; landing(); if (message) toast(message); }
function connect() {
  clearTimeout(pollTimer); const epoch = ++pollEpoch;
  async function poll() {
    if (!token || epoch !== pollEpoch) return;
    const sessionToken = token;
    try {
      const result = await request('GET', undefined, sessionToken);
      if (epoch !== pollEpoch || token !== sessionToken) return;
      $('#connection').hidden = true; acceptState(result.state);
    } catch (error) {
      if (epoch !== pollEpoch) return;
      if ([401, 410].includes(error.status)) return resetSession(error.message);
      $('#connection').hidden = false;
    }
    if (epoch === pollEpoch && token) pollTimer = setTimeout(poll, document.hidden ? 3000 : 1200);
  }
  poll();
}
const isHost = () => state.hostId === state.me.id;
function roster() {
  const players = [...state.players].sort((a, b) => b.score - a.score);
  return players.map(p => `<div class="player"><div class="avatar color-${state.players.findIndex(x => x.id === p.id) % 4}">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</div><div class="player-name"><strong>${escapeHtml(p.name)}${p.id === state.me.id ? ' <small>(you)</small>' : ''}</strong><span>${!p.connected ? 'Reconnecting…' : p.id === state.hostId ? 'Host' : 'Ready to play'}${p.submitted && state.phase === 'answer' ? ' · Answer in ✓' : ''}${p.voted && state.phase === 'vote' ? ' · Voted ✓' : ''}</span></div>${state.phase === 'lobby' ? (isHost() && p.id !== state.me.id ? `<button class="remove" data-remove="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">×</button>` : '<span class="player-dot ' + (!p.connected ? 'away' : '') + '"></span>') : `<div class="score">${p.score}<small>${p.gained && ['results','finished'].includes(state.phase) ? '+' + p.gained : 'PTS'}</small></div>`}</div>`).join('');
}
function layout() {
  app.innerHTML = `<div class="room-top"><div><div class="eyebrow">THE PARTY ROOM</div><h1 id="room-heading">Make it a good one.</h1></div><button id="copy-code" class="room-code" title="Copy invitation link"><span>ROOM CODE · COPY INVITE</span><b>${state.code} <small>⧉</small></b></button></div><div class="game-grid"><section id="stage" class="stage card" aria-label="Current round"></section><aside><section class="roster card"><div class="roster-heading"><h2>The crowd</h2><span id="player-count"></span></div><div id="players"></div><div class="room-hint">${state.houseMode ? 'DUO MODE · A house answer joins the mix. Vote for your friend or the house.' : 'Everyone plays on their own device. Keep this tab open to stay in the room.'}</div></section><details class="rules"><summary>How to play <span>＋</span></summary><p>${state.totalRounds} rounds. Write an answer in 45 seconds, then vote in 20 seconds. Answers are anonymous until the reveal. No self-votes. Each vote earns its author 100 points.</p><p>Missing an answer or vote earns no points from that action. Your submitted answer can still receive votes. Tied leaders get one extra round; a remaining tie is a shared win.</p><p>For two players, a house answer gives each voter a choice. The house never scores. A house answer also fills in if fewer than two people submit.</p></details><div id="leave-slot"></div></aside></div>`;
}
function stageMarkup() {
  const s = state;
  if (s.phase === 'lobby') return `<div class="lobby-art" aria-hidden="true"><span>?</span><span>!</span><i>✦</i></div><span class="pill">THE MORE, THE MERRIER</span><h2>Your people go here.</h2><p class="stage-lede">Share code <strong>${s.code}</strong> and gather the gang.<br>Two to eight players. Absolutely no talent required.</p><div class="lobby-actions">${isHost() ? '<button id="start" class="primary wide">Everybody in? Let’s play <span>→</span></button><p id="start-hint" class="subtle"></p>' : '<div class="waiting"><span class="live-dot"></span> Waiting for the host to start…</div>'}</div><div class="round-preview"><span>WRITE <b>45s</b></span><i>→</i><span>VOTE <b>20s</b></span><i>→</i><span>REVEAL <b>★</b></span></div>`;
  if (s.phase === 'finished') {
    const winners = s.players.filter(p => s.winners.includes(p.id));
    return `<div class="winner-icon" aria-hidden="true">✳</div><span class="pill">THAT’S A WRAP</span><h2>${winners.length === 1 ? escapeHtml(winners[0].name) + ' takes the crown.' : 'The glory is shared.'}</h2><p class="stage-lede">${winners.length > 1 ? escapeHtml(winners.map(p => p.name).join(' & ')) + '<br>' : ''}<strong>${winners[0]?.score || 0} points</strong> and some very questionable answers.</p><div class="podium">${[...s.players].sort((a,b) => b.score-a.score).map(p=>`<div><span>${s.winners.includes(p.id) ? '★' : '·'} ${escapeHtml(p.name)}</span><b>${p.score}</b></div>`).join('')}</div>${isHost() ? '<button id="replay" class="primary wide">One more game? <span>↻</span></button>' : '<p class="subtle">Waiting for the host to open a new lobby.</p>'}`;
  }
  const common = `<div class="round-top"><span class="pill">${s.round > s.totalRounds ? 'TIE-BREAKER' : 'ROUND ' + s.round + ' / ' + s.totalRounds} · ${s.phase === 'answer' ? 'WRITE' : s.phase === 'vote' ? 'VOTE' : 'REVEAL'}</span><span class="timer" aria-label="Seconds remaining"><span id="seconds">—</span><small>s</small></span></div><h2 class="prompt">${escapeHtml(s.prompt)}</h2>`;
  if (s.phase === 'answer') return common + `<p class="stage-lede">First thought? Probably the best thought.</p><div id="answer-area"></div><div id="progress" class="progress" role="status"></div>`;
  if (s.phase === 'vote') return common + `<p class="stage-lede">Pick the answer that deserves the applause.</p><div id="answer-options" class="options">${s.answers.map((a,i)=>`<button class="answer-option" data-vote="${a.id}" ${a.mine ? 'disabled' : ''}><span class="option-letter">${String.fromCharCode(65+i)}</span><span>${escapeHtml(a.text)}${a.mine ? '<small>Your answer · no self-votes</small>' : ''}</span><span class="option-arrow">↗</span></button>`).join('')}</div><div id="vote-status" class="waiting" role="status" hidden>✓ Vote locked in. Waiting for the reveal…</div><div id="progress" class="progress" role="status"></div>`;
  return common + `<p class="stage-lede">The votes are in. Own your answer.</p><div class="results-list">${[...s.answers].sort((a,b)=>b.votes-a.votes).map(a=>`<div class="result-answer ${a.votes ? 'has-votes' : ''}"><div><p>${escapeHtml(a.text)}</p><span>${escapeHtml(a.author)}${a.mine ? ' (you)' : ''}</span></div><b>${a.owner ? '+' + a.votes*100 : '—'}<small>${a.votes} ${a.votes === 1 ? 'vote' : 'votes'}</small></b></div>`).join('')}</div><div class="results-foot"><span>Next up automatically in <b id="next-seconds"></b>s</span>${isHost() ? '<button id="next" class="secondary">Continue →</button>' : ''}</div>`;
}
function render() {
  const newKey = state.phase + state.roundKey + isHost();
  if (!$('#stage')) layout();
  if (newKey !== stageKey) { stageKey = newKey; $('#stage').innerHTML = stageMarkup(); }
  $('#players').innerHTML = roster(); $('#player-count').textContent = state.players.length + ' / 8';
  $('#leave-slot').innerHTML = ['lobby','finished'].includes(state.phase) ? '<button id="leave" class="text-button">Leave room ↗</button>' : '';
  $('#room-heading').textContent = state.phase === 'lobby' ? 'Good company. Bad jokes.' : state.phase === 'finished' ? 'A round of applause.' : 'Make it a good one.';
  $('.room-hint').textContent = state.houseMode ? 'DUO MODE · A house answer joins the mix. Vote for your friend or the house.' : 'Everyone plays on their own device. Keep this tab open to stay in the room.';
  if (state.phase === 'lobby' && isHost()) {
    const count = state.players.filter(p => p.connected).length;
    $('#start').disabled = count < 2;
    $('#start-hint').textContent = count < 2 ? 'Waiting for at least one more player.' : count + ' connected. Start whenever you’re ready.';
  }
  if (state.phase === 'answer') {
    if (state.me.answer) { $('#answer-area').innerHTML = `<div class="locked-answer"><span>✓ YOUR ANSWER IS IN</span><p>${escapeHtml(state.me.answer)}</p><small>Now act like you didn’t write it.</small></div>`; }
    else if (!$('#answer-form')) {
      const draftKey = 'pp-draft-' + state.code + '-' + state.roundKey;
      $('#answer-area').innerHTML = `<form id="answer-form"><label for="answer">YOUR MASTERPIECE</label><textarea id="answer" maxlength="160" required rows="3" placeholder="Go on. Make them laugh.">${escapeHtml(readSaved(draftKey) || '')}</textarea><div class="answer-tools"><span><span id="char-count">${(readSaved(draftKey) || '').length}</span> / 160</span><button class="primary" type="submit">Lock it in <span>→</span></button></div></form>`;
    }
    $('#progress').textContent = state.players.filter(p=>p.submitted).length + ' of ' + state.players.length + ' answers in';
  }
  if (state.phase === 'vote') {
    document.querySelectorAll('[data-vote]').forEach(button => button.disabled = state.me.voted || state.answers.find(a=>a.id === button.dataset.vote).mine);
    $('#vote-status').hidden = !state.me.voted;
    $('#progress').textContent = state.players.filter(p=>p.voted).length + ' of ' + state.players.length + ' votes in';
  }
  updateTimer();
}
function updateTimer() {
  if (!state?.deadline) return;
  const remaining = Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000));
  if ($('#seconds')) { $('#seconds').textContent = remaining; $('.timer').classList.toggle('urgent', remaining <= 10); }
  if ($('#next-seconds')) $('#next-seconds').textContent = remaining;
}
setInterval(updateTimer, 200);
app.addEventListener('input', event => {
  if (event.target.id === 'room-code') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (event.target.id === 'answer') { $('#char-count').textContent = event.target.value.length; save('pp-draft-' + state.code + '-' + state.roundKey, event.target.value); }
});
app.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return; pending = true;
  const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    if (event.target.id === 'entry-form') {
      const data = Object.fromEntries(new FormData(event.target));
      const fingerprint = JSON.stringify({ action: entryMode, ...data });
      let intent; try { intent = JSON.parse(readSaved('pp-entry-intent')); } catch {}
      if (!intent || intent.fingerprint !== fingerprint) intent = { fingerprint, sessionKey: newId() + newId() };
      save('pp-entry-intent', JSON.stringify(intent));
      const result = await api(entryMode, { ...data, sessionKey: intent.sessionKey });
      save('pp-entry-intent', null);
      token = result.token; state = result.state; clockOffset = state.serverTime - Date.now(); save('pp-token', token); save('pp-name', data.name);
      stageKey = ''; app.innerHTML = ''; render(); connect();
    } else if (event.target.id === 'answer-form') { await api('answer', { answer: $('#answer').value, roundKey: state.roundKey }); }
  } catch (err) { const message = err.name === 'AbortError' ? 'Connection timed out. Please try again.' : err.message; if ($('#entry-error')) $('#entry-error').textContent = message; else toast(message); }
  finally { pending = false; if (button.isConnected) button.disabled = false; }
});
app.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.mode) { save('pp-name', $('#nickname')?.value || ''); entryMode = button.dataset.mode; landing(); return; }
  if (button.id === 'copy-code') {
    const link = location.origin + '/?room=' + state.code;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied. Send it to your friends.'); }
    catch { toast('Room code: ' + state.code); window.prompt('Copy this invitation link:', link); } return;
  }
  const action = button.dataset.vote ? 'vote' : button.dataset.remove ? 'remove' : ['start','next','replay','leave'].includes(button.id) ? button.id : null;
  if (!action || pending) return; pending = true; button.disabled = true;
  try {
    await api(action, { roundKey: state.roundKey, answerId: button.dataset.vote, playerId: button.dataset.remove });
    if (action === 'leave') resetSession();
  } catch (err) { toast(err.name === 'AbortError' ? 'Connection timed out. Please try again.' : err.message); }
  finally { pending = false; if (button.isConnected) button.disabled = false; if (state) render(); }
});
async function boot() {
  if (!token) return landing();
  app.innerHTML = '<div class="loading">Getting the gang back together…</div>';
  try {
    const result = await request('GET');
    state = result.state; clockOffset = state.serverTime - Date.now(); render(); connect();
  } catch (error) {
    if ([401,410].includes(error.status)) return resetSession(error.message);
    app.innerHTML = '<div class="loading">Couldn’t reach the game. Check your connection and refresh to reconnect.</div>';
  }
}
boot();
