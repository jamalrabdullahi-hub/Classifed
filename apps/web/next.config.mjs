import createNextIntlPlugin from 'next-intl/plugin';
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
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

  webpack: (config, { isServer, webpack }) => {
    if (isServer) {
      // `serverExternalPackages` does not reach modules imported *through* a
      // package listed in `transpilePackages`, and argon2 is reached that way
      // (app -> @flt/core -> @node-rs/argon2). Without this, webpack tries to
      // parse the compiled .node binary as JavaScript and the build fails.
      // Requiring it at runtime is also correct for a native addon: Node picks
      // the right platform binary, not the bundle.
      config.externals = [...(config.externals ?? []), '@node-rs/argon2'];
    } else {
      // Password hashing must never be reachable from the browser bundle.
      // Resolving it to `false` turns an accidental client import into a build
      // error rather than a shipped binary.
      config.resolve.fallback = { ...config.resolve.fallback, '@node-rs/argon2': false };
    }

    // The `wagmi/connectors` barrel reaches Coinbase's SDK, which dynamically
    // imports a family of optional @x402 payment modules that are not installed
    // and that this product never calls. They are guarded by a helper that
    // tolerates a failed import, so ignoring the whole namespace is safe — and
    // aliasing them one at a time turned into whack-a-mole.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));

    return config;
  },

  /**
   * The old English route names, permanently redirected to their Somali
   * replacements.
   *
   * Two things depend on the old paths staying reachable: `/reset-password`
   * and `/verify-email` are mailed to users with a token in the query string,
   * and any of these may be bookmarked or already indexed. A redirect costs
   * nothing and means neither breaks — new navigation uses the Somali paths
   * (see `nav.tsx` and every internal `Link`), this list only catches what
   * was already out in the world before the rename.
   */
  /**
   * Digital Asset Links for the Android app.
   *
   * Served from a route rather than a static file so the signing fingerprints
   * come from the server environment and can change without a code deploy —
   * the Play app-signing certificate is only known once the app is uploaded.
   */
  async rewrites() {
    return [{ source: '/.well-known/assetlinks.json', destination: '/api/assetlinks' }];
  },

  async redirects() {
    const renamed = [
      ['/account', '/akoon'],
      ['/activity', '/dhaqdhaqaaq'],
      ['/dashboard', '/guriga'],
      ['/markets', '/suuqyada'],
      ['/passive-cash', '/lacag-fadhiya'],
      ['/perps', '/ganacsi'],
      ['/plans', '/qorshayaal'],
      ['/portfolio', '/hantida'],
      ['/referrals', '/jeedin'],
      ['/trade', '/iibso'],
      ['/upgrade', '/kordhi'],
      ['/verify', '/xaqiijin'],
      ['/wallets', '/boorso'],
      ['/login', '/gal'],
      ['/register', '/is-diiwaan-geli'],
      ['/forgot-password', '/dib-u-deji'],
      ['/reset-password', '/beddel-furaha'],
      ['/verify-email', '/xaqiiji-iimaylka'],
    ];

    return renamed.flatMap(([from, to]) => [
      { source: from, destination: to, permanent: true },
      { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: true },
    ]);
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

export default withNextIntl(nextConfig);
