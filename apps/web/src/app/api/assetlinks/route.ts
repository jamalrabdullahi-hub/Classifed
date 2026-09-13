import { NextResponse } from 'next/server';
import { env } from '@flt/config';
import { assetLinksFor } from '@flt/core/domain/asset-links';

/**
 * `/.well-known/assetlinks.json`, via the rewrite in next.config.
 *
 * Public by design — Google and every Android device fetch it anonymously. The
 * fingerprints come from the environment so the Play app-signing certificate,
 * which only exists once the app is uploaded, can be added without a deploy.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const { ANDROID_PACKAGE_NAME, ANDROID_CERT_SHA256 } = env();
  return NextResponse.json(assetLinksFor(ANDROID_PACKAGE_NAME, ANDROID_CERT_SHA256), {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
