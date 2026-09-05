/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than a build step, so Next
  // compiles them as part of the app.
  transpilePackages: ['@flt/ui', '@flt/core', '@flt/db', '@flt/providers', '@flt/config'],
  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
};

export default nextConfig;
