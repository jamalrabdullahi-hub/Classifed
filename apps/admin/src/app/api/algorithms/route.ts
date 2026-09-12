import { z } from 'zod';
import { AlgorithmStrategy } from '@flt/db';
import { createAlgorithm } from '@flt/core/services/algorithms';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Create a catalog entry.
 *
 * New algorithms are created inactive — an entry that trades the moment it is
 * saved would be a live strategy nobody reviewed. An operator activates it as a
 * separate, deliberate click.
 */
const schema = z.object({
  slug: z.string().trim().min(2).max(64),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(400),
  strategy: z.nativeEnum(AlgorithmStrategy),
  params: z.record(z.unknown()).optional(),
  symbols: z.array(z.string().trim().min(1).max(24)).min(1).max(20),
  maxLeverage: z.coerce.number().int().min(1).max(100),
  maxNotionalUsd: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal'),
  priceUsd: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Must be a USD amount'),
  periodDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  isActive: z.coerce.boolean().optional(),
  isFeatured: z.coerce.boolean().optional(),
  reason: reasonSchema,
});

export const POST = adminHandler(
  { schema, permission: PERMISSIONS.MANAGE_ALGORITHMS },
  async ({ admin, body }) => {
    const { reason: _reason, ...input } = body;
    const row = await createAlgorithm(admin, input);
    return { id: row.id, slug: row.slug, isActive: row.isActive };
  },
);
