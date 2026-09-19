import type { MetadataRoute } from 'next';
import { LEARN_ARTICLES } from '@/content/learn-articles';

const LEARN = 'https://learn.ftlexchange.com';

/** FTL Learn: the home page and every Somali article. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${LEARN}/`, changeFrequency: 'weekly', priority: 1 },
    ...LEARN_ARTICLES.map((article) => ({
      url: `${LEARN}/${article.slug}`,
      lastModified: article.updated,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
  ];
}
