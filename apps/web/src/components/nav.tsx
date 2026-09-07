'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeftRight,
  ChevronDown,
  Gauge,
  LayoutGrid,
  LineChart,
  LogOut,
  Menu,
  PieChart,
  Receipt,
  Settings,
  Wallet,
  Sparkles,
  PiggyBank,
  Gift,
  X,
} from 'lucide-react';
import { cn } from '@flt/ui';
import { Wordmark } from './brand';
import { ThemeToggle } from './theme';
import { LanguageSwitcher } from './language-switcher';

/**
 * Primary navigation.
 *
 * The order follows the order of the work: see the market, place a trade, check
 * what you hold, review what happened. Wallets and Account sit behind the
 * account menu because they are settings, not destinations.
 */
const PRIMARY = [
  { href: '/dashboard', key: 'home', icon: LayoutGrid },
  { href: '/markets', key: 'scanner', icon: LineChart },
  { href: '/portfolio', key: 'portfolio', icon: PieChart },
  { href: '/activity', key: 'activity', icon: Receipt },
] as const;

/**
 * The terminal is where trading happens, so it carries the name.
 *
 * The spot swap page still exists at /trade and is reachable from a token's
 * page in the scanner; it is no longer a top-level destination, because two
 * tabs both called some variant of "trade" made the user choose between them
 * before knowing what the difference was.
 */
const TRADE = { href: '/perps', key: 'trade', icon: Gauge } as const;

/**
 * Referrals sits in the primary bar rather than the account menu.
 *
 * A referral programme nobody can find earns nothing. It was behind the avatar
 * dropdown alongside Wallets and Account, which is where settings live — and a
 * thing somebody is meant to act on is not a setting. It goes after Trade
 * because that is the order of the work: trade first, then tell people about it.
 */
const REFERRALS = { href: '/referrals', key: 'referrals', icon: Gift } as const;

const ACCOUNT = [
  { href: '/plans', key: 'plans', icon: Sparkles },
  { href: '/passive-cash', key: 'passiveCash', icon: PiggyBank },
  { href: '/wallets', key: 'wallets', icon: Wallet },
  { href: '/account', key: 'account', icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopNav({ email, perpsEnabled = false }: { email: string; perpsEnabled?: boolean }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const t = useTranslations('nav');
  // Without perpetuals the spot swap page takes the Trade slot, so the
  // destination exists either way.
  const primary = perpsEnabled
    ? [...PRIMARY, TRADE, REFERRALS]
    : [...PRIMARY, { href: '/trade', key: 'trade', icon: ArrowLeftRight } as const, REFERRALS];

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--canvas)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-4 sm:px-6">
        <Link href="/dashboard" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {primary.map(({ href, key }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? 'page' : undefined}
              className={cn(
                'rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium transition-colors',
                isActive(pathname, href)
                  ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]',
              )}
            >
              {t(key)}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitcher className="hidden sm:inline-flex" />
          <ThemeToggle className="hidden sm:inline-flex" />
          <AccountMenu email={email} pathname={pathname} />

          <button
            type="button"
            onClick={() => setMobileOpen((open) => !open)}
            className="rounded-[var(--radius-md)] p-2 text-[var(--text-muted)] md:hidden"
            aria-label={mobileOpen ? t('closeMenu') : t('openMenu')}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <nav
          className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2 md:hidden"
          aria-label="Primary"
        >
          {[...primary, ...ACCOUNT].map(({ href, key, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-sm',
                isActive(pathname, href)
                  ? 'bg-[var(--surface-hover)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-muted)]',
              )}
            >
              <Icon className="size-4" />
              {t(key)}
            </Link>
          ))}
          <div className="flex items-center justify-between px-3 py-3">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function AccountMenu({ email, pathname }: { email: string; pathname: string }) {
  const [open, setOpen] = useState(false);
  const t = useTranslations('nav');

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className={cn(
          'flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)]',
          'bg-[var(--surface)] py-1 pl-1 pr-2 transition-colors hover:bg-[var(--surface-hover)]',
        )}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          className={cn(
            'flex size-6 items-center justify-center rounded-[var(--radius-sm)]',
            'bg-[var(--accent-subtle)] text-[11px] font-semibold uppercase text-[var(--accent-text)]',
          )}
          aria-hidden="true"
        >
          {email.slice(0, 2)}
        </span>
        <ChevronDown className="size-3 text-[var(--text-subtle)]" />
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute right-0 top-full z-50 mt-1.5 w-60 animate-fade-up overflow-hidden',
            'rounded-[var(--radius-lg)] border border-[var(--border)]',
            'bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]',
          )}
        >
          <div className="border-b border-[var(--border)] px-3 py-2.5">
            <p className="truncate text-[13px] font-medium text-[var(--text)]">{email}</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">{t('signedIn')}</p>
          </div>

          <div className="p-1">
            {ACCOUNT.map(({ href, key, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                role="menuitem"
                className={cn(
                  'flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[13px]',
                  isActive(pathname, href)
                    ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
                )}
              >
                <Icon className="size-3.5" />
                {t(key)}
              </Link>
            ))}
          </div>

          <form action="/api/auth/logout" method="post" className="border-t border-[var(--border)] p-1">
            <button
              type="submit"
              role="menuitem"
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px]',
                'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
              )}
            >
              <LogOut className="size-3.5" />
              {t('signOut')}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
