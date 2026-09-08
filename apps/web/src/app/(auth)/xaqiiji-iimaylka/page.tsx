import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VerifyEmailForm } from './verify-email-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleConfirmEmail') };
}
export const dynamic = 'force-dynamic';

/**
 * Email confirmation, reached from the link in a verification email.
 *
 * Deliberately outside the authenticated shell. Someone clicking a link in
 * their inbox is very often not signed in — different browser, different
 * device, a week later — and bouncing them to a login form loses the token
 * they arrived with. The token is the credential for this one action; it
 * proves control of the mailbox and needs nothing else.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <VerifyEmailForm token={token ?? null} />;
}
