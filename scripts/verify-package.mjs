import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { startBlobFixture } from '../test/support/blob-service.mjs';
import { setEnvironmentContext } from '@netlify/blobs';

const archive=await readFile('artifacts/functions/game.zip'), files=unzipSync(archive);
assert.ok(files['___netlify-entry-point.mjs']);
assert.ok(files['netlify/functions/game.mjs']);
const temp=await mkdtemp(join(tmpdir(),'prompt-panic-package-'));
const functionDir=join(temp,'function');
const blobs=await startBlobFixture();
const prior=process.env.NETLIFY_BLOBS_CONTEXT;
try {
  for(const [name,bytes] of Object.entries(files)) {
    assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));
    const destination=join(functionDir,name);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);
  }
  setEnvironmentContext({siteID:'packaged-function-test',token:'local-test-token',edgeURL:'http://127.0.0.1:1',uncachedEdgeURL:blobs.url});
  const {default:game}=await import(pathToFileURL(join(functionDir,'netlify/functions/game.mjs')).href);
  assert.equal(typeof game,'function');
  async function call(action,data={},token) {
    const response=await game(new Request('https://game.example/.netlify/functions/game',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({action,requestId:randomUUID(),...data})}),{});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  }
  const secret=()=>randomUUID()+randomUUID();
  const host=await call('create',{name:'Alex',sessionKey:secret(),totalRounds:3});
  const guest=await call('join',{name:'Sam',sessionKey:secret(),code:host.state.code});
  let s=(await call('start',{roundKey:host.state.roundKey},host.token)).state;
  const rounds=[];
  for(let r=1;r<=3;r++) {
    assert.equal(s.phase,'answer');assert.equal(s.round,r);const roundKey=s.roundKey;
    await call('answer',{answer:`Alex ${r}`,roundKey},host.token);
    s=(await call('answer',{answer:`Sam ${r}`,roundKey},guest.token)).state;
    assert.equal(s.phase,'vote');assert.equal(s.answers.length,3);
    const alex=s.answers.find(a=>a.text===`Alex ${r}`),sam=s.answers.find(a=>a.text===`Sam ${r}`),house=s.answers.find(a=>a!==alex&&a!==sam);
    await call('vote',{answerId:r===1?sam.id:house.id,roundKey},host.token);
    s=(await call('vote',{answerId:r===3?house.id:alex.id,roundKey},guest.token)).state;
    assert.equal(s.phase,'results');assert.deepEqual(s.players.map(p=>p.score),r===1?[100,100]:[200,100]);
    rounds.push({round:r,Alex:s.players[0].score,Sam:s.players[1].score});
    s=(await call('next',{roundKey},host.token)).state;
  }
  assert.equal(s.phase,'finished');assert.equal(s.round,3);assert.deepEqual(s.winners,[host.state.me.id]);
  const html=await readFile('dist/index.html','utf8');
  assert.ok(html.includes('type="module"'));assert.ok(!html.includes('/src/'));
  const assets=await readdir('dist/assets');
  const js=await readFile(join('dist/assets',assets.find(f=>f.endsWith('.js'))),'utf8');
  assert.ok(js.includes('/.netlify/functions/game'));assert.ok(!js.includes('/api/'));assert.ok(!js.includes('EventSource'));
  const functionSources=await readdir('netlify/functions');assert.deepEqual(functionSources,['game.ts']);
  const config=await readFile('netlify.toml','utf8');assert.ok(!config.includes('[[redirects]]'));assert.ok(!config.includes('[build.environment]'));
  assert.equal(blobs.stats.unconditionalWrites,0);
  const report={verifiedAt:new Date().toISOString(),node:process.version,productionBuild:'passed',packagedFunction:'passed: imported compiled game.mjs from the Netlify-produced ZIP and executed all actions',storage:'real Netlify Blobs SDK against a local HTTP fixture implementing ETags and conditional writes; uncached strong-read endpoint verified',rounds,winner:'Alex',finalScores:{Alex:200,Sam:100},endpoint:'/.netlify/functions/game',functionZipSHA256:createHash('sha256').update(archive).digest('hex'),liveNetlifyDeployment:'not performed; no account was accessed',notes:'Concurrency and ETag retry tests additionally run against an atomic test store. The source project is rebuilt by Netlify on signed-in drag-and-drop deployment.'};
  await writeFile('VERIFICATION.json',JSON.stringify(report,null,2)+'\n');
  console.log('PASS: production assets, direct endpoint, sole Function entry, and packaged Function.');
  console.log('PASS: complete packaged two-player, three-round game. Alex 200, Sam 100; winner Alex.');
} finally {
  await blobs.stop();await rm(temp,{recursive:true,force:true});
  if(prior===undefined)delete process.env.NETLIFY_BLOBS_CONTEXT;else process.env.NETLIFY_BLOBS_CONTEXT=prior;
}
