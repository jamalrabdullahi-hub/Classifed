import { z } from 'zod';
import { AlgorithmKind, AlgorithmStrategy } from '@flt/db';
import { createAlgorithm } from '@flt/core/services/algorithms';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Create an offering.
 *
 * New offerings are created INACTIVE — publishing automation that trades real
 * money is a deliberate operator decision. The AI offering defaults to
 * Pro-only.
 */
const schema = z.object({
  slug: z.string().trim().min(2).max(64),
  kind: z.nativeEnum(AlgorithmKind),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(400),
  strategy: z.nativeEnum(AlgorithmStrategy).optional(),
  params: z.record(z.unknown()).optional(),
  symbols: z.array(z.string().trim().min(1).max(24)).min(1).max(20),
  maxLeverage: z.coerce.number().int().min(1).max(100),
  maxNotionalUsd: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal'),
  managementFeeBps: z.coerce.number().int().min(0).max(5_000).optional(),
  requiresPro: z.coerce.boolean().optional(),
  systemPrompt: z.string().trim().max(2_000).nullable().optional(),
  promptRails: z.array(z.string().trim().min(1).max(1_000)).max(10).optional(),
  periodDays: z.coerce.number().int().min(1).max(3_650).nullable().optional(),
  isActive: z.coerce.boolean().optional(),
  isFeatured: z.coerce.boolean().optional(),
  reason: reasonSchema,
});

export const POST = adminHandler(
  { schema, permission: PERMISSIONS.MANAGE_ALGORITHMS },
  async ({ admin, body }) => {
    const { reason: _reason, ...input } = body;
    const row = await createAlgorithm(admin, input);
    return { id: row.id, slug: row.slug, kind: row.kind, isActive: row.isActive };
  },
);
