import { z } from 'zod';
import { env } from '@flt/config';
import { ValidationError } from '@flt/core/domain';
import { documentStore } from '@flt/providers';
import { attachDocument } from '@flt/core/services/kyc-documents';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Uploading an identity document.
 *
 * The bytes travel as base64 in JSON; the client resizes an image first so it
 * fits behind the proxy's 1 MB request cap. The file is stored encrypted at
 * rest and a metadata row records its hash, size and the retention clock the
 * purge job reads. Nothing here approves anything — verification stays a human
 * decision.
 */
const schema = z.object({
  documentType: z.enum(['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE']),
  mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  dataBase64: z.string().min(16).max(8_000_000),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'kyc-document' } },
  async ({ body, user }) => {
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length > env().KYC_DOCUMENT_MAX_BYTES) {
      throw new ValidationError('That document is too large. Please upload a smaller file.');
    }

    const document = await attachDocument(documentStore(), user, {
      documentType: body.documentType,
      mimeType: body.mimeType,
      bytes,
    });

    return {
      id: document.id,
      documentType: document.documentType,
      sha256: document.sha256,
      sizeBytes: document.sizeBytes,
      retentionUntil: document.retentionUntil?.toISOString() ?? null,
    };
  },
);
