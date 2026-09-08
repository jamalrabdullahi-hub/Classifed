import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { env } from '@flt/config';
import { ValidationError } from '../domain/errors';

/**
 * The one place in the codebase that deliberately holds a private key.
 *
 * Everywhere else, ADR 0001 is absolute: FLT never signs, never holds a key.
 * Agentic trading breaks that on purpose — a model deciding trades while the
 * participant is offline needs something able to sign without them present.
 * Confining the exception to this one module, rather than letting key
 * material flow through general-purpose code, is what makes it auditable:
 * every place a plaintext key can exist in the process is this file.
 *
 * AES-256-GCM, not because GCM is exotic but because it is authenticated —
 * a corrupted or tampered ciphertext fails to decrypt loudly rather than
 * producing a plausible-looking wrong key that goes on to sign something.
 */

const ALGORITHM = 'aes-256-gcm';

export interface EncryptedKey {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function masterKey(): Buffer {
  const raw = env().AGENT_KEY_ENCRYPTION_KEY;
  if (!raw) {
    throw new ValidationError(
      'Agentic trading is not configured on this deployment (no AGENT_KEY_ENCRYPTION_KEY).',
    );
  }
  return Buffer.from(raw, 'hex');
}

/** Generates a fresh EOA. The caller decides what venue it will be used for. */
export function generateAgentKeypair(): { privateKey: Hex; address: Address } {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return { privateKey, address };
}

export function encryptPrivateKey(privateKey: Hex): EncryptedKey {
  const iv = randomBytes(12); // GCM's recommended nonce size
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion: 1,
  };
}

/**
 * Decrypts a stored key.
 *
 * Returns the key, not a signer — the caller (the executor, and only the
 * executor) constructs whatever venue-specific client needs it and lets it
 * go out of scope immediately after. Nothing decrypted here is logged, cached,
 * or returned across a request boundary.
 */
export function decryptPrivateKey(stored: EncryptedKey): Hex {
  if (stored.keyVersion !== 1) {
    throw new ValidationError('Unknown agent key version', { keyVersion: stored.keyVersion });
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey(), Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(stored.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8') as Hex;
}
