import { env } from '@flt/config';
import { ProviderError, ProviderNotConfiguredError } from '@flt/core/domain';
import type {
  MailProvider,
  PasswordResetEmail,
  SecurityAlertEmail,
  VerificationEmail,
} from './types.js';

/**
 * Resend adapter.
 *
 * Bodies are plain text and built here rather than pulled from a template
 * service, so it is possible to read this file and know exactly what leaves the
 * system. Nothing beyond the link itself is included: no name, no account
 * details, nothing that turns an intercepted email into a profile.
 */
export class ResendMailProvider implements MailProvider {
  readonly name = 'resend';

  async sendVerification(message: VerificationEmail): Promise<void> {
    await this.send(
      message.to,
      'Verify your FLT Exchange email address',
      [
        'Confirm this email address to finish setting up your FLT Exchange account:',
        '',
        message.verifyUrl,
        '',
        'This link can be used once and expires in 24 hours.',
        'If you did not create an account, you can ignore this message.',
      ].join('\n'),
    );
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    await this.send(
      message.to,
      'Reset your FLT Exchange password',
      [
        'Use this link to choose a new password:',
        '',
        message.resetUrl,
        '',
        `This link can be used once and expires in ${message.expiresInMinutes} minutes.`,
        'If you did not request this, no action is needed — your password has not changed.',
      ].join('\n'),
    );
  }

  async sendSecurityAlert(message: SecurityAlertEmail): Promise<void> {
    await this.send(
      message.to,
      message.subject,
      [
        message.headline,
        '',
        message.body,
        '',
        `When: ${message.occurredAt.toISOString()}`,
        `IP address: ${message.ip ?? 'unknown'}`,
        '',
        'If this was not you, change your password and review your active sessions.',
      ].join('\n'),
    );
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return env().RESEND_API_KEY
      ? { ok: true }
      : { ok: false, detail: 'RESEND_API_KEY is not set' };
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    const config = env();
    if (!config.RESEND_API_KEY) {
      throw new ProviderNotConfiguredError(this.name, 'RESEND_API_KEY is not set');
    }

    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: config.MAIL_FROM_ADDRESS, to, subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, 'Mail provider did not respond', {
        retryable: true,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    if (!response.ok) {
      // The body may echo the recipient address; keep it out of the error and
      // out of any log that error reaches.
      throw new ProviderError(this.name, 'Mail provider rejected the message', {
        retryable: response.status >= 500 || response.status === 429,
        details: { status: response.status },
      });
    }
  }
}
