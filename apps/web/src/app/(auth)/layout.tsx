import Link from 'next/link';
import { CustodyNote, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';

/**
 * Shell for sign-in, registration and recovery.
 *
 * A single centred column rather than the marketing split-screen. Someone
 * signing in has already decided; the screen's job is to get out of the way.
 * The custody note stays visible because these are the pages a phishing clone
 * would imitate, and the reminder that FLT never asks for a seed phrase is most
 * useful next to a password field.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/">
            <Wordmark />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>

      <footer className="border-t border-[var(--border)] py-6">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <CustodyNote className="max-w-xl" />
        </div>
      </footer>
    </div>
  );
}
