import { zipFunctions } from '@netlify/zip-it-and-ship-it';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
const output = resolve('artifacts/functions');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const functions = await zipFunctions(resolve('netlify/functions'), output, {
  basePath: process.cwd(),
  config: { '*': { nodeBundler: 'esbuild', nodeVersion: '22.x' } }
});
if (functions.length !== 1 || functions[0].name !== 'game') throw new Error('Expected exactly the game function.');
await writeFile(resolve('artifacts/function-build.json'), JSON.stringify(functions.map(f => ({ name: f.name, runtime: f.runtime, file: basename(f.path), size: f.size, mainFile: f.mainFile ? 'netlify/functions/game.ts' : undefined })), null, 2) + '\n');
console.log('Packaged standard Netlify Function: artifacts/functions/game.zip');
