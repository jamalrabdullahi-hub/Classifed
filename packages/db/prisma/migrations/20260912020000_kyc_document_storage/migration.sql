-- Identity-document storage: content hash, mime/size, the storage key, and
-- the retention clock the purge job reads. Metadata rows are kept on purge.
ALTER TABLE "kyc_documents" ADD COLUMN "sha256" TEXT;
ALTER TABLE "kyc_documents" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "kyc_documents" ADD COLUMN "sizeBytes" INTEGER;
ALTER TABLE "kyc_documents" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "kyc_documents" ADD COLUMN "retentionUntil" TIMESTAMP(3);
ALTER TABLE "kyc_documents" ADD COLUMN "purgedAt" TIMESTAMP(3);
