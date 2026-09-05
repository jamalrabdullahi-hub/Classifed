/**
 * Transactional email.
 *
 * Only three messages exist in Phase 1, and all three carry a single-use token.
 * That is why the interface takes structured inputs rather than a rendered
 * body: a caller cannot accidentally log the token by passing it through a
 * generic `send(html)`, and the token never appears in a template argument
 * that ends up in an error report.
 */

export interface VerificationEmail {
  to: string;
  verifyUrl: string;
}

export interface PasswordResetEmail {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface SecurityAlertEmail {
  to: string;
  subject: string;
  headline: string;
  body: string;
  occurredAt: Date;
  ip: string | null;
}

export interface MailProvider {
  readonly name: string;

  sendVerification(message: VerificationEmail): Promise<void>;
  sendPasswordReset(message: PasswordResetEmail): Promise<void>;
  sendSecurityAlert(message: SecurityAlertEmail): Promise<void>;

  health(): Promise<{ ok: boolean; detail?: string }>;
}
