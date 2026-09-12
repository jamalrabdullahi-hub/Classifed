import { z } from 'zod';
import { AlgorithmStrategy } from '@flt/db';
import { updateAlgorithm } from '@flt/core/services/algorithms';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Edit a catalog entry (including activating or deactivating it).
 *
 * The slug is immutable — it is the public identifier in routes and API paths,
 * so renaming it would break a link somebody already has. Everything else is
 * editable.
 */
const schema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(400).optional(),
  strategy: z.nativeEnum(AlgorithmStrategy).optional(),
  params: z.record(z.unknown()).optional(),
  symbols: z.array(z.string().trim().min(1).max(24)).min(1).max(20).optional(),
  maxLeverage: z.coerce.number().int().min(1).max(100).optional(),
  maxNotionalUsd: z.string().trim().regex(/^\d+(\.\d+)?$/).optional(),
  priceUsd: z.string().trim().regex(/^\d+(\.\d{1,2})?$/).optional(),
  periodDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  isActive: z.coerce.boolean().optional(),
  isFeatured: z.coerce.boolean().optional(),
  reason: reasonSchema,
});

export const PATCH = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { schema, permission: PERMISSIONS.MANAGE_ALGORITHMS },
  async ({ admin, body, params }) => {
    const { reason: _reason, ...input } = body;
    const row = await updateAlgorithm(admin, params.id, input);
    return { id: row.id, slug: row.slug, isActive: row.isActive };
  },
);
