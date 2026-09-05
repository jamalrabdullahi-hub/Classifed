import { isProduction } from '@flt/config';
import type {
  MailProvider,
  PasswordResetEmail,
  SecurityAlertEmail,
  VerificationEmail,
} from './types';

/**
 * Development mail: prints the message to stdout.
 *
 * The verification and reset links are printed in full, because during
 * development you need to click them. That is exactly why the environment
 * schema refuses to boot in production with `MAIL_PROVIDER=console` — this
 * adapter writes single-use credentials to the process log, which is fine on a
 * developer's terminal and unacceptable on a server.
 *
 * The constructor asserts the same rule, so the guarantee survives someone
 * constructing this directly rather than through the registry.
 */
export class ConsoleMailProvider implements MailProvider {
  readonly name = 'console';

  constructor() {
    if (isProduction()) {
      throw new Error(
        'ConsoleMailProvider prints verification links to stdout and must never run in production',
      );
    }
  }

  async sendVerification(message: VerificationEmail): Promise<void> {
    this.print('Verify your email address', message.to, [`Verify: ${message.verifyUrl}`]);
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    this.print('Reset your password', message.to, [
      `Reset: ${message.resetUrl}`,
      `Expires in ${message.expiresInMinutes} minutes`,
    ]);
  }

  async sendSecurityAlert(message: SecurityAlertEmail): Promise<void> {
    this.print(message.subject, message.to, [
      message.headline,
      message.body,
      `When: ${message.occurredAt.toISOString()}`,
      `IP: ${message.ip ?? 'unknown'}`,
    ]);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'stdout' };
  }

  private print(subject: string, to: string, lines: string[]): void {
    const rule = '─'.repeat(72);
    console.info(
      [
        '',
        rule,
        `  MAIL (development)  →  ${to}`,
        `  ${subject}`,
        rule,
        ...lines.map((line) => `  ${line}`),
        rule,
        '',
      ].join('\n'),
    );
  }
}
