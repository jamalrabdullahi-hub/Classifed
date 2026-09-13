import { describe, expect, it } from 'vitest';
import {
  ASSET_LINK_RELATION,
  assetLinksFor,
  normaliseFingerprint,
} from '../src/domain/asset-links';

/**
 * The file that decides whether the Android app opens full-screen.
 *
 * A mistake here does not crash anything — the app just shows a URL bar — which
 * is why it is worth pinning: the failure is silent until somebody installs it.
 */

const UPLOAD = '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';
const PLAY_BARE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';

describe('normaliseFingerprint', () => {
  it('keeps the colon form, uppercased', () => {
    expect(normaliseFingerprint(UPLOAD.toLowerCase())).toBe(UPLOAD);
  });

  it('converts a bare 64-character hex fingerprint to the colon form', () => {
    expect(normaliseFingerprint(PLAY_BARE)).toBe(
      'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    );
  });

  it('rejects anything that is not a SHA-256 fingerprint', () => {
    expect(normaliseFingerprint('')).toBeNull();
    expect(normaliseFingerprint('AB:CD')).toBeNull();
    // A SHA-1 fingerprint is a common copy-paste mistake from keytool output.
    expect(normaliseFingerprint('14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42')).toBeNull();
    expect(normaliseFingerprint('zz'.repeat(32))).toBeNull();
  });
});

describe('assetLinksFor', () => {
  it('vouches for nothing when no fingerprint is configured', () => {
    expect(assetLinksFor('com.ftlexchange.app', undefined)).toEqual([]);
    expect(assetLinksFor('com.ftlexchange.app', '')).toEqual([]);
  });

  it('publishes a single fingerprint', () => {
    expect(assetLinksFor('com.ftlexchange.app', UPLOAD)).toEqual([
      {
        relation: [ASSET_LINK_RELATION],
        target: {
          namespace: 'android_app',
          package_name: 'com.ftlexchange.app',
          sha256_cert_fingerprints: [UPLOAD],
        },
      },
    ]);
  });

  it('publishes both the Play and upload fingerprints, normalised and deduplicated', () => {
    const [statement] = assetLinksFor('com.ftlexchange.app', ` ${UPLOAD} , ${PLAY_BARE}, ${UPLOAD.toLowerCase()}`);
    expect(statement!.target.sha256_cert_fingerprints).toHaveLength(2);
    expect(statement!.target.sha256_cert_fingerprints[0]).toBe(UPLOAD);
  });

  it('drops invalid fingerprints but keeps the valid ones', () => {
    const [statement] = assetLinksFor('com.ftlexchange.app', `nonsense,${UPLOAD}`);
    expect(statement!.target.sha256_cert_fingerprints).toEqual([UPLOAD]);
  });

  it('vouches for nothing with an invalid package name', () => {
    expect(assetLinksFor('not a package', UPLOAD)).toEqual([]);
  });
});
