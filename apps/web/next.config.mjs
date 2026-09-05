/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Workspace packages ship TypeScript source rather than a build step, so Next
  // compiles them as part of the app.
  transpilePackages: ['@flt/ui', '@flt/core', '@flt/db', '@flt/providers', '@flt/config'],

  // Prisma loads its query engine at runtime and must not be bundled.
  serverExternalPackages: ['@prisma/client', 'prisma'],

  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,

  webpack: (config, { isServer }) => {
    if (isServer) {
      // `serverExternalPackages` does not reach modules imported *through* a
      // package listed in `transpilePackages`, and argon2 is reached that way
      // (app -> @flt/core -> @node-rs/argon2). Without this, webpack tries to
      // parse the compiled .node binary as JavaScript and the build fails.
      // Requiring it at runtime is also the correct behaviour for a native
      // addon: the right platform binary is chosen by Node, not by the bundle.
      config.externals = [...(config.externals ?? []), '@node-rs/argon2'];
    } else {
      // Password hashing must never be reachable from the browser bundle.
      // Resolving it to `false` turns an accidental client import into a build
      // error rather than a shipped binary.
      config.resolve.fallback = { ...config.resolve.fallback, '@node-rs/argon2': false };
    }
    return config;
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
