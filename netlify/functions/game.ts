import type { Context } from '@netlify/functions';
import { createHandler } from '../lib/handler';
import { roomStore } from '../lib/storage';

// Standard endpoint: /.netlify/functions/game. No custom path or redirect.
export default async function game(request: Request, _context: Context): Promise<Response> {
  try {
    return await createHandler({ store: roomStore() })(request);
  } catch {
    return Response.json({ error: 'The game service is temporarily unavailable. Please try again.' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' }
    });
  }
}
