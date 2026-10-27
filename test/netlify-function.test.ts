import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBlobFixture } from './support/blob-service.mjs';
import { getStore, setEnvironmentContext } from '@netlify/blobs';
import game from '../netlify/functions/game';
import { completeThreeRoundGame } from './helpers';

test('standard Function executes a full three-round match through the real Blobs SDK and an ETag HTTP fixture', async t => {
  const directory=await mkdtemp(join(tmpdir(),'prompt-panic-blobs-'));
  const blobs=await startBlobFixture();
  const prior=process.env.NETLIFY_BLOBS_CONTEXT;
  setEnvironmentContext({siteID:'local-test-site',token:'local-test-token',edgeURL:'http://127.0.0.1:1',uncachedEdgeURL:blobs.url});
  t.after(async()=>{await blobs.stop();await rm(directory,{recursive:true,force:true});if(prior===undefined)delete process.env.NETLIFY_BLOBS_CONTEXT;else process.env.NETLIFY_BLOBS_CONTEXT=prior;});
  const result=await completeThreeRoundGame(req=>game(req,{} as any));
  assert.equal(blobs.stats.unconditionalWrites,0);
  assert.equal(result.winner,'Alex'); assert.deepEqual(result.finalScores,[200,100]);
  // Exercise the SDK's actual conditional create and ETag rejection paths.
  const store=getStore({name:'conditional-write-check',consistency:'strong'});
  assert.equal((await store.setJSON('key',{v:1},{onlyIfNew:true})).modified,true);
  assert.equal((await store.setJSON('key',{v:2},{onlyIfNew:true})).modified,false);
  const entry=await store.getWithMetadata('key',{type:'json',consistency:'strong'});
  assert.ok(entry?.etag);
  assert.equal((await store.setJSON('key',{v:2},{onlyIfMatch:entry.etag})).modified,true);
  assert.equal((await store.setJSON('key',{v:3},{onlyIfMatch:entry.etag})).modified,false);
  assert.equal((await store.get('key',{type:'json'})).v,2);
});
