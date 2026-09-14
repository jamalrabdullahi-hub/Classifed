import type { MetadataRoute } from 'next';

/** Learn's single page. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: 'https://learn.ftlexchange.com/', changeFrequency: 'monthly', priority: 1 }];
}
