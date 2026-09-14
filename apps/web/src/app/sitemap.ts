import type { MetadataRoute } from 'next';

/** The one public page. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.WEB_APP_URL ?? 'http://localhost:3000';
  return [{ url: `${base}/guriga`, changeFrequency: 'monthly', priority: 1 }];
}
