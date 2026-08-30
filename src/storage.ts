import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

/**
 * Where uploaded images live.
 *
 * Markdown always stores `/api/uploads/<name>` — that path is the stable public
 * identity of an image and never changes, whichever driver is behind it. Switching
 * PINBALL_STORAGE from `local` to `s3` therefore needs no rewrite of anyone's notes:
 * the route either streams the bytes or redirects to the CDN.
 */
export interface ImageStore {
  put(data: Buffer, ext: string, contentType: string): Promise<string>;
  read(name: string): Promise<{ stream: Readable; size: number } | null>;
  remove(name: string): Promise<void>;
  /** An absolute URL a browser on another origin can fetch, or null to stream. */
  publicUrl(name: string): string | null;
}

/** No SVG: it is a script container, and these are served from domains we own. */
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

/** 128 bits of randomness is the access control (D13) — names must be unguessable. */
const newName = (ext: string) => `${randomBytes(16).toString('hex')}.${ext}`;

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------- local */

function localStore(dir: string): ImageStore {
  mkdirSync(dir, { recursive: true });
  return {
    async put(data, ext) {
      const name = newName(ext);
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
    publicUrl: () => null,
  };
}

/* ---------------------------------------------------------------------- s3 */

function s3Store(): ImageStore {
  // Imported lazily so a local-storage deployment never pays for the AWS SDK.
  const clientPromise = import('@aws-sdk/client-s3').then((mod) => ({
    mod,
    client: new mod.S3Client({
      region: env.s3.region,
      endpoint: env.s3.endpoint,
      // R2, MinIO and friends need path-style addressing; real S3 does not care.
      forcePathStyle: Boolean(env.s3.endpoint),
      credentials: {
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
      },
    }),
  }));

  const key = (name: string) => (env.s3.prefix ? `${env.s3.prefix}/${name}` : name);

  return {
    async put(data, ext, contentType) {
      const { mod, client } = await clientPromise;
      const name = newName(ext);
      await client.send(
        new mod.PutObjectCommand({
          Bucket: env.s3.bucket,
          Key: key(name),
          Body: data,
          ContentType: contentType,
          // The name is random, so the bytes at a key never change.
          CacheControl: 'public, max-age=31536000, immutable',
          // Deliberately absent by default. AWS buckets made since 2023 have
          // ACLs disabled, where sending one fails the upload; R2 has no object
          // ACLs at all and grants public read via a custom domain instead. Both
          // are the common case, so this is opt-in through S3_ACL.
          ...(process.env.S3_ACL ? { ACL: process.env.S3_ACL as 'public-read' } : {}),
        }),
      );
      return name;
    },

    async read(name) {
      const { mod, client } = await clientPromise;
      try {
        const out = await client.send(
          new mod.GetObjectCommand({ Bucket: env.s3.bucket, Key: key(name) }),
        );
        if (!out.Body) return null;
        return { stream: out.Body as Readable, size: Number(out.ContentLength ?? 0) };
      } catch {
        return null;
      }
    },

    async remove(name) {
      const { mod, client } = await clientPromise;
      await client
        .send(new mod.DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key(name) }))
        .catch(() => undefined);
    },

    publicUrl: (name) => (env.s3.publicBase ? `${env.s3.publicBase}/${key(name)}` : null),
  };
}

export const images: ImageStore =
  env.storage === 's3'
    ? s3Store()
    : localStore(env.uploadsDir || resolve(here, '../data/uploads'));

/**
 * Turn a stored markdown src into something a browser on a published subdomain can
 * load. Published pages are served from <handle>.pinball.sh, so a bare
 * `/api/uploads/x.png` there would resolve against the wrong host.
 */
export function imageUrl(src: string): string {
  const match = /^\/api\/uploads\/([0-9a-f]{32}\.[a-z]+)$/.exec(src);
  if (!match) return src;
  return images.publicUrl(match[1]) ?? `${env.appOrigin}${src}`;
}
