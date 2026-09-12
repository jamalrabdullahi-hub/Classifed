import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@flt/config';
import { decryptSecret, encryptSecret } from '@flt/core/services';
import type { DocumentStore, DocumentStoreMeta } from '@flt/core/ports';

/**
 * A filesystem document store, encrypted at rest.
 *
 * The cheapest place to keep an upload is the disk the app already runs on.
 * Bytes are AES-256-GCM encrypted (the MFA-secret primitive) before they touch
 * the filesystem, so a copy of `KYC_DOCUMENT_DIR` is not a copy of anyone's
 * passport. Keys are opaque server-generated ids, never user data, so a
 * directory listing leaks nothing either.
 */
const KEY_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

export class LocalDocumentStore implements DocumentStore {
  readonly meta: DocumentStoreMeta = { slug: 'local' };

  private directory(): string {
    return env().KYC_DOCUMENT_DIR;
  }

  private pathFor(key: string): string {
    // A key is always a server-generated id. Reject anything else rather than
    // build a path from it — the key is the one input that could escape the dir.
    if (!KEY_PATTERN.test(key)) throw new Error('Refusing an unsafe document key');
    return join(this.directory(), key);
  }

  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    await mkdir(this.directory(), { recursive: true });
    await writeFile(this.pathFor(key), encryptSecret(bytes.toString('base64')), 'utf8');
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const payload = await readFile(this.pathFor(key), 'utf8');
      return Buffer.from(decryptSecret(payload), 'base64');
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
