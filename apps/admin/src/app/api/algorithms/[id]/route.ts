import { z } from 'zod';
import { AlgorithmKind, AlgorithmStrategy } from '@flt/db';
import { updateAlgorithm } from '@flt/core/services/algorithms';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Edit an offering (including activating or deactivating it). The slug is
 * immutable.
 */
const schema = z.object({
  kind: z.nativeEnum(AlgorithmKind).optional(),
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(400).optional(),
  strategy: z.nativeEnum(AlgorithmStrategy).optional(),
  params: z.record(z.unknown()).optional(),
  symbols: z.array(z.string().trim().min(1).max(24)).min(1).max(20).optional(),
  maxLeverage: z.coerce.number().int().min(1).max(100).optional(),
  maxNotionalUsd: z.string().trim().regex(/^\d+(\.\d+)?$/).optional(),
  managementFeeBps: z.coerce.number().int().min(0).max(5_000).optional(),
  requiresPro: z.coerce.boolean().optional(),
  systemPrompt: z.string().trim().max(2_000).nullable().optional(),
  promptRails: z.array(z.string().trim().min(1).max(1_000)).max(10).optional(),
  periodDays: z.coerce.number().int().min(1).max(3_650).nullable().optional(),
  isActive: z.coerce.boolean().optional(),
  isFeatured: z.coerce.boolean().optional(),
  reason: reasonSchema,
});

export const PATCH = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { schema, permission: PERMISSIONS.MANAGE_ALGORITHMS },
  async ({ admin, body, params }) => {
    const { reason: _reason, ...input } = body;
    const row = await updateAlgorithm(admin, params.id, input);
    return { id: row.id, slug: row.slug, kind: row.kind, isActive: row.isActive };
  },
);
