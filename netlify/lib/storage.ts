import { getStore } from '@netlify/blobs';
import type { Room } from './engine';

export type RoomEntry = { data: Room; etag: string };
export interface RoomStore {
  read(key: string): Promise<RoomEntry | null>;
  write(key: string, data: Room, condition: { onlyIfNew: true } | { onlyIfMatch: string }): Promise<{ modified: boolean }>;
}
export function roomStore(): RoomStore {
  // Runtime credentials are supplied automatically by Netlify. No user configuration.
  const store = getStore({ name: 'prompt-panic-rooms-v1', consistency: 'strong' });
  return {
    async read(key) {
      const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
      if (!entry) return null;
      if (!entry.etag) throw new Error('Room storage returned no ETag; refusing an unconditional update.');
      return { data: entry.data as Room, etag: entry.etag };
    },
    write: (key, data, condition) => store.setJSON(key, data, condition)
  };
}
