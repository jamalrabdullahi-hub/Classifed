import type { MetadataRoute } from 'next';

/** Crawlers may read the wallet landing page and nothing else. */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.WEB_APP_URL ?? 'http://localhost:3000';
  return {
    rules: [{ userAgent: '*', allow: ['/guriga$'], disallow: ['/'] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
