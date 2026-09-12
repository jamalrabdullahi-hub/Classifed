import { documentStore } from '@flt/providers';
import { purgeExpiredDocuments } from '@flt/core/services/kyc-documents';

/**
 * Retention purge.
 *
 * Deletes the stored blob of every identity document past its retention date,
 * keeping the metadata row so the audit trail still shows a document was held
 * and when it was destroyed. This is the only pass in the worker that touches
 * documents, and it runs slowly — a document's clock is measured in years.
 */
export async function runDocumentRetention(): Promise<{ purged: number }> {
  return purgeExpiredDocuments(documentStore());
}
