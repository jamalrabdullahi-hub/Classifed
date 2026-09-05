import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Isolated in its own module because it is the only thing in the codebase that
 * needs a native binary. Session resolution runs on every request and must not
 * drag a compiled `.node` file into the bundle graph, so anything that only
 * needs a fast hash imports `./hashing` instead.
 *
 * Argon2id at OWASP's recommended floor: 19 MiB memory, 2 iterations, 1 degree
 * of parallelism.
 */
export const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

/**
 * Verifies a password. Returns false rather than throwing on a malformed hash,
 * so a corrupted row denies access instead of returning a 500 that tells an
 * attacker the account exists.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A valid Argon2id hash of a value nobody knows.
 *
 * Verified against when an email is unknown, so an attacker cannot enumerate
 * accounts by measuring how long a login takes.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zdGF0aWMtc2FsdA$Qm9ndXNIYXNoRm9yVGltaW5nRXF1YWxpdHk';
