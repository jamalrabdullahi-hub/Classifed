import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, KeyRound, Route, ShieldCheck, Wallet } from 'lucide-react';
import { Button } from '@flt/ui';
import { Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { env } from '@flt/config';
import { currentUser } from '@/server/session';

/**
 * Landing page.
 *
 * Written to set the expectation the product has to meet: this is not an
 * exchange that holds your money. The custody model is the headline rather than
 * a footnote, because a user who does not understand it will be confused by
 * every screen that follows.
 *
 * No price tickers, no volume counters, no urgency. Those belong to a different
 * kind of product.
 */
export default async function HomePage() {
  const user = await currentUser();
  if (user) redirect('/dashboard');

  const perpsEnabled = env().PERPS_ENABLED;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Wordmark />
          <div className="flex items-center gap-3">
            <ThemeToggle className="hidden sm:inline-flex" />
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild variant="primary" size="sm">
              <Link href="/register">Open an account</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-[var(--border)]">
          <div className="grid-texture absolute inset-0 opacity-[0.35]" aria-hidden="true" />

          <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <p className="text-[13px] font-medium uppercase tracking-[0.12em] text-[var(--accent-text)]">
              Non-custodial trading
            </p>

            <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-[-0.03em] text-[var(--text)] sm:text-5xl">
              Trade on decentralized exchanges without handing over your assets.
            </h1>

            <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-[var(--text-muted)]">
              FLT routes your order across on-chain liquidity and builds the transaction. Your
              wallet signs it, the blockchain settles it, and your funds never pass through us. We
              never ask for a seed phrase or a private key, because we never need one.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild variant="primary" size="lg">
                <Link href="/register">
                  Open an account
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            How a trade works
          </h2>

          <ol className="mt-8 grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Wallet,
                step: '01',
                title: 'Connect your wallet',
                body: 'Link a self-custody wallet by signing a message. No transfer, no deposit, no gas.',
              },
              {
                icon: Route,
                step: '02',
                title: 'Review the route',
                body: 'See the expected output, the guaranteed minimum, price impact, every fee, and the contract being called.',
              },
              {
                icon: KeyRound,
                step: '03',
                title: 'Sign it yourself',
                body: 'Your wallet signs and broadcasts. FLT holds no keys and cannot move your funds.',
              },
              {
                icon: ShieldCheck,
                step: '04',
                title: 'Settle on-chain',
                body: 'We watch the transaction and record what actually happened, not what we expected.',
              },
            ].map(({ icon: Icon, step, title, body }) => (
              <li key={step} className="bg-[var(--surface)] p-6">
                <div className="flex items-center gap-2.5">
                  <Icon className="size-4 text-[var(--accent)]" aria-hidden="true" />
                  <span className="num text-[11px] font-medium tracking-[0.08em] text-[var(--text-subtle)]">
                    {step}
                  </span>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-[var(--text)]">{title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-[var(--border)] bg-[var(--surface-sunken)]">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--text)]">
                What we do not do
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-[var(--text-muted)]">
                Being clear about the limits matters more than a feature list. FLT is deliberately
                not a centralized exchange, and several things you may expect from one are absent by
                design.
                {/* Tied to the flag rather than written as a fixed claim. This
                    sentence has now been wrong in both directions: it once said
                    leverage was not offered after perpetuals were built, and
                    saying they are available while the feature is switched off
                    would be just as untrue. */}
                {perpsEnabled ? (
                  <>
                    {' '}
                    Perpetual futures are available to verified accounts and are leveraged
                    products: they can be closed automatically and you can lose the margin
                    backing them.
                  </>
                ) : null}
              </p>
            </div>

            <ul className="space-y-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {[
                'We do not hold your assets, so there is no FLT balance to withdraw.',
                'We do not operate an order book and cannot match your trade internally.',
                'We cannot reverse a transaction. Once your wallet signs, it is on-chain.',
                'We do not custody your assets, so there is nothing here for us to lend against or lose.',
                'We never request a seed phrase, private key or wallet password — nobody legitimate ever will.',
              ].map((item) => (
                <li key={item} className="flex gap-3">
                  <span
                    className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--text-subtle)]"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:px-6">
          <Wordmark />
          <p className="max-w-2xl text-[12px] leading-relaxed text-[var(--text-subtle)]">
            Digital assets are volatile and you can lose money. Trades settle on public blockchains
            and cannot be reversed once signed. FLT-Exchange provides an interface to decentralized
            liquidity; it does not provide investment advice and does not take custody of client
            assets.
          </p>
        </div>
      </footer>
    </div>
  );
}
