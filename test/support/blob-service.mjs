import { createServer } from 'node:http';
// Test-only HTTP fixture for Netlify Blobs' documented ETag protocol.
// The current official local emulator omits ETags on GET responses. Production
// must never work around a missing ETag by falling back to unconditional writes.
export async function startBlobFixture() {
  const blobs = new Map();
  const stats = { reads: 0, writes: 0, conflicts: 0, unconditionalWrites: 0 };
  let version = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-test-token') { res.writeHead(401); return res.end(); }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET') {
      stats.reads++; const entry = blobs.get(path);
      if (!entry) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: entry.etag }); return res.end(entry.body);
    }
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      // Check and commit after reading the body; no await between CAS and write.
      const current = blobs.get(path), match = req.headers['if-match'], fresh = req.headers['if-none-match'];
      if (!match && fresh !== '*') { stats.unconditionalWrites++; res.writeHead(400); return res.end(); }
      if ((fresh === '*' && current) || (match && current?.etag !== match)) {
        stats.conflicts++; res.writeHead(412); return res.end();
      }
      stats.writes++; const etag = `"version-${++version}"`; blobs.set(path, { body, etag });
      res.writeHead(200, { ETag: etag }); return res.end();
    }
    res.writeHead(405); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, stats,
    async stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
