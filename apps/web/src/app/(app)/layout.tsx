import { LegalLinks } from '@/components/legal-links';
import { redirect } from 'next/navigation';
import { AccountStatus } from '@flt/db';
import { env } from '@flt/config';
import { CustodyNote } from '@/components/brand';
import { TopNav } from '@/components/nav';
import { Providers } from '@/components/providers';
import { currentUser } from '@/server/session';

/**
 * Shell for every screen under this group, authenticated or not.
 *
 * The KYC gate lives on the trade path rather than here: a user awaiting
 * verification can still see markets, link a wallet and read their account.
 * Locking the whole application behind verification would leave them with a
 * single screen and nothing to do while they wait.
 *
 * ## This layout no longer requires a session
 *
 * The trading terminal (`/ganacsi`) and the plans page (`/qorshayaal`) are
 * deliberately open to a signed-out visitor — someone deciding whether to
 * open an account should be able to see the real screen first, not a
 * marketing description of it. Every other page under this group still
 * guards itself: each one calls `requireUserPage()` on its own and redirects
 * to `/gal` individually, so removing the blanket redirect here does not
 * open anything that was not already meant to be public.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  // A suspended account keeps its session but loses the application. The
  // dedicated page explains what happened rather than bouncing them to a login
  // form that would appear to accept their password and then fail.
  if (user?.accountStatus === AccountStatus.SUSPENDED) redirect('/suspended');

  // Signed out, the only page that renders here is the wallet landing, which
  // carries its own header and footer (see src/middleware.ts).
  if (!user) return <Providers>{children}</Providers>;

  return (
    <Providers>
      <div className="flex min-h-screen flex-col">
      <TopNav email={user?.email ?? null} perpsEnabled={env().PERPS_ENABLED} />

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-8 sm:px-6">{children}</main>

      <footer className="border-t border-[var(--border)] py-6">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-4 sm:px-6">
          <CustodyNote className="max-w-2xl" />
          <LegalLinks />
          <p className="text-[11px] text-[var(--text-subtle)]">
            Digital assets are volatile and trades settle on public blockchains. Transactions cannot
            be reversed once signed.
          </p>
        </div>
      </footer>
      </div>
    </Providers>
  );
}
