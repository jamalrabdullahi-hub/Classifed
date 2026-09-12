/**
 * A blob store for identity documents.
 *
 * A port, not an SDK call: where an upload lives (the VPS disk, a mounted
 * volume, S3/R2) is commercial and reversible, while the retention and
 * screening rules around it are not. Everything above this interface deals in
 * bytes under a key; moving to cheaper or larger storage is a new adapter.
 *
 * The bytes are the most sensitive data the platform holds. An adapter MUST
 * encrypt at rest — the local adapter does, with the same AES-256-GCM primitive
 * as MFA secrets — so possession of the storage directory alone yields nothing.
 */
export interface DocumentStoreMeta {
  readonly slug: string;
}

export interface DocumentStore {
  readonly meta: DocumentStoreMeta;
  /** Writes bytes under a key, replacing any existing object. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Reads the bytes back, or null if the object is gone. */
  get(key: string): Promise<Buffer | null>;
  /** Removes the object. Idempotent — deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
