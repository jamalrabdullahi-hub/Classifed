import { createHash, randomBytes } from 'node:crypto';
import { env } from '@flt/config';
import { prisma, type KycDocument } from '@flt/db';
import type { DocumentStore } from '../ports';
import { ValidationError } from '../domain/errors';
import { newId } from '../domain/id';

/**
 * Identity-document storage and retention.
 *
 * The blob (encrypted by the store) and the metadata row are separate concerns:
 * the row is the audit trail and outlives the blob, which is destroyed when its
 * retention clock runs out. Nothing here decides a verification — it only holds
 * what a reviewer needs and guarantees it does not outlive its lawful window.
 */

export interface AttachDocumentInput {
  documentType: string;
  mimeType: string;
  bytes: Buffer;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/**
 * Stores one document and records it against the customer's KYC profile.
 *
 * The profile is created as a placeholder if the customer uploads before
 * submitting the form, so a document is never orphaned and the later
 * `submitKyc` upsert finds it. Idempotency is not needed: two uploads are two
 * documents, and the reviewer sees both.
 */
export async function attachDocument(
  store: DocumentStore,
  user: { id: string },
  input: AttachDocumentInput,
): Promise<KycDocument> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new ValidationError('Upload a JPEG, PNG or PDF.');
  }
  if (input.bytes.length === 0) {
    throw new ValidationError('That file was empty.');
  }
  if (input.bytes.length > env().KYC_DOCUMENT_MAX_BYTES) {
    throw new ValidationError('That document is too large. Please upload a smaller file.');
  }

  const profile = await prisma.kycProfile.upsert({
    where: { userId: user.id },
    create: { id: newId(), userId: user.id, provider: 'manual' },
    update: {},
  });

  const key = randomBytes(24).toString('hex');
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await store.put(key, input.bytes, input.mimeType);

  const retentionUntil = new Date(Date.now() + env().KYC_DOCUMENT_RETENTION_DAYS * 86_400_000);

  return prisma.kycDocument.create({
    data: {
      id: newId(),
      kycProfileId: profile.id,
      documentType: input.documentType,
      externalRef: key,
      storageKey: key,
      sha256,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      retentionUntil,
    },
  });
}

/**
 * Deletes the stored blob of every document past its retention date.
 *
 * The metadata row is kept — it is the evidence that a document was held and
 * when it was destroyed — with `storageKey` cleared and `purgedAt` stamped, so
 * a second pass cannot try to delete the same blob twice.
 */
export async function purgeExpiredDocuments(
  store: DocumentStore,
  now: Date = new Date(),
): Promise<{ purged: number }> {
  const due = await prisma.kycDocument.findMany({
    where: { retentionUntil: { lte: now }, purgedAt: null, storageKey: { not: null } },
    take: 500,
  });

  let purged = 0;
  for (const document of due) {
    if (document.storageKey) {
      await store.delete(document.storageKey).catch(() => undefined);
    }
    await prisma.kycDocument.update({
      where: { id: document.id },
      data: { purgedAt: new Date(), storageKey: null },
    });
    purged += 1;
  }
  return { purged };
}
