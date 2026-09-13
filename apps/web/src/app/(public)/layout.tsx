import Link from 'next/link';
import { CustodyNote, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { LegalLinks } from '@/components/legal-links';

/**
 * Shell for pages anyone can read without an account: the app download, the
 * privacy policy, the terms, and how to delete an account.
 *
 * The same header as sign-in, so these read as part of FLT rather than a
 * separate site, but a wider column than the sign-in card — a privacy policy
 * squeezed into 400 pixels is technically published and practically unread.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
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

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">{children}</main>

      <footer className="border-t border-[var(--border)] py-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:px-6">
          <CustodyNote className="max-w-xl" />
          <LegalLinks />
        </div>
      </footer>
    </div>
  );
}
