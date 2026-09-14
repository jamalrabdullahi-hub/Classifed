import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

/**
 * Learn is public and indexable. The exchange keeps its pages' own `noindex`
 * metadata while unlaunched; robots.txt does not hide it from anybody.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = ((await headers()).get('host') ?? '').split(':')[0];
  if (host === 'learn.ftlexchange.com') {
    return { rules: [{ userAgent: '*', allow: '/' }], sitemap: 'https://learn.ftlexchange.com/sitemap.xml' };
  }
  return { rules: [{ userAgent: '*', allow: '/' }] };
}
