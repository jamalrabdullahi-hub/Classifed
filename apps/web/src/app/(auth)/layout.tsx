import Link from 'next/link';
import { headers } from 'next/headers';
import { CustodyNote, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { LegalLinks } from '@/components/legal-links';

/**
 * Shell for sign-in, registration and recovery.
 *
 * A single centred column rather than the marketing split-screen. Someone
 * signing in has already decided; the screen's job is to get out of the way.
 * The custody note stays visible because these are the pages a phishing clone
 * would imitate, and the reminder that FLT never asks for a seed phrase is most
 * useful next to a password field.
 *
 * Sign-up is FTL Learn's, whichever site sent the visitor: every new account
 * starts as a free Learn account that cannot trade, so the page carries Learn's
 * name rather than the exchange's. `src/middleware.ts` marks that request.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const isSignup = (await headers()).get('x-flt-surface') === 'signup';

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          {isSignup ? (
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]">FTL Learn</span>
          ) : (
            <Link href="/">
              <Wordmark />
            </Link>
          )}
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>

      <footer className="border-t border-[var(--border)] py-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:px-6">
          {isSignup ? null : <CustodyNote className="max-w-xl" />}
          <LegalLinks />
        </div>
      </footer>
    </div>
  );
}
