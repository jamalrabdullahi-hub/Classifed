/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
};
export default nextConfig;

// Makes Cloudflare bindings available to `next dev`. No-op outside Cloudflare
// tooling, so the plain Node dev server is unaffected.
if (process.env.NODE_ENV === 'development') {
  const { initOpenNextCloudflareForDev } = await import('@opennextjs/cloudflare')
    .catch(() => ({ initOpenNextCloudflareForDev: undefined }));
  initOpenNextCloudflareForDev?.();
}
