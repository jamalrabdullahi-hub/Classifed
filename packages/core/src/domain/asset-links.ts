/**
 * Digital Asset Links for the Android app.
 *
 * Chrome opens a Trusted Web Activity full-screen only when the site vouches
 * for the app: `/.well-known/assetlinks.json` must name the app's package and
 * the SHA-256 fingerprint of a certificate it was signed with. If it does not
 * match, the app still opens — with a browser URL bar across the top, which
 * reads as broken and invites exactly the phishing confusion a trading app
 * should avoid.
 *
 * Pure, so it can be tested without a server. An invalid fingerprint is dropped
 * rather than published: a malformed entry cannot match any certificate, and
 * serving it would only hide the real misconfiguration.
 */

export const ASSET_LINK_RELATION = 'delegate_permission/common.handle_all_urls';

export interface AssetLinkStatement {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

const COLON_FORM = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;
const BARE_FORM = /^[0-9A-Fa-f]{64}$/;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** A fingerprint in the colon-separated uppercase form Google publishes, or null. */
export function normaliseFingerprint(raw: string): string | null {
  const value = raw.trim();
  if (COLON_FORM.test(value)) return value.toUpperCase();
  if (BARE_FORM.test(value)) {
    return value
      .toUpperCase()
      .match(/.{2}/g)!
      .join(':');
  }
  return null;
}

/**
 * The statement list to serve. Empty when there is no valid package or no valid
 * fingerprint — an empty list is a valid file that simply vouches for nothing.
 */
export function assetLinksFor(
  packageName: string,
  fingerprints: string | null | undefined,
): AssetLinkStatement[] {
  const pkg = packageName.trim();
  if (!PACKAGE_NAME.test(pkg)) return [];

  const list = [
    ...new Set(
      (fingerprints ?? '')
        .split(',')
        .map(normaliseFingerprint)
        .filter((value): value is string => value !== null),
    ),
  ];
  if (list.length === 0) return [];

  return [
    {
      relation: [ASSET_LINK_RELATION],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: list },
    },
  ];
}
