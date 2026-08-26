import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where uploaded images live. Local disk for now; S3 slots in behind the same
 * interface by adding a driver and switching on PINBALL_STORAGE, with no change
 * to the routes or to anything already stored in a question's markdown — those
 * reference `/api/uploads/<name>`, which stays the public URL either way.
 */
export interface ImageStore {
  put(data: Buffer, ext: string): Promise<string>;
  read(name: string): Promise<{ stream: Readable; size: number } | null>;
  remove(name: string): Promise<void>;
}

/** No SVG: it is a script container, and these are served from our own origin. */
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export const MAX_BYTES = 8 * 1024 * 1024;

/** Only ever a name we generated — never anything derived from the client. */
export const SAFE_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp|avif)$/;

export const typeFor = (name: string): string => {
  const ext = name.split('.').pop();
  return Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
};

const here = dirname(fileURLToPath(import.meta.url));

function localStore(dir: string): ImageStore {
  mkdirSync(dir, { recursive: true });
  return {
    async put(data, ext) {
      const name = `${randomBytes(16).toString('hex')}.${ext}`;
      await writeFile(resolve(dir, name), data);
      return name;
    },
    async read(name) {
      const path = resolve(dir, name);
      if (!existsSync(path)) return null;
      return { stream: createReadStream(path), size: statSync(path).size };
    },
    async remove(name) {
      const path = resolve(dir, name);
      if (existsSync(path)) await unlink(path);
    },
  };
}

// PINBALL_STORAGE=s3 will select an s3Store(...) here once it exists.
export const images: ImageStore = localStore(
  process.env.PINBALL_UPLOADS ?? resolve(here, '../data/uploads'),
);
