'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Coins,
  FileText,
  Gauge,
  LayoutDashboard,
  LogOut,
  Percent,
  Route,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import { Badge, cn } from '@flt/ui';
import { ThemeToggle } from './theme';

/**
 * Admin shell.
 *
 * A sidebar rather than a top bar: this panel has a dozen destinations and an
 * operator moves between them constantly, so the whole map stays visible.
 *
 * The environment is stated in the header at all times. An operator who cannot
 * tell production from staging will eventually suspend the wrong account.
 */

const SECTIONS: { label: string; items: { href: string; label: string; icon: typeof Users }[] }[] = [
  {
    label: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/health', label: 'System health', icon: Gauge },
    ],
  },
  {
    label: 'Customers',
    items: [
      { href: '/users', label: 'Users', icon: Users },
      { href: '/kyc', label: 'KYC queue', icon: ShieldCheck },
      { href: '/wallets', label: 'Wallets', icon: Wallet },
      { href: '/transactions', label: 'Transactions', icon: Activity },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/tokens', label: 'Tokens', icon: Coins },
      { href: '/providers', label: 'DEX providers', icon: Route },
      { href: '/fees', label: 'Fees', icon: Percent },
    ],
  },
  {
    label: 'Compliance',
    items: [{ href: '/audit', label: 'Audit log', icon: FileText }],
  },
];

export function AdminShell({
  email,
  role,
  environment,
  children,
}: {
  email: string;
  role: string;
  environment: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isProduction = environment === 'production';

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-[var(--border)] px-4">
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text)]">
            FLT<span className="text-[var(--text-subtle)]"> Admin</span>
          </span>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto p-3" aria-label="Admin">
          {SECTIONS.map((section) => (
            <div key={section.label}>
              <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(({ href, label, icon: Icon }) => {
                  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-[13px] transition-colors',
                        active
                          ? 'bg-[var(--surface-hover)] font-medium text-[var(--text)]'
                          : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      {label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--border)] p-3">
          <p className="truncate text-[12px] font-medium text-[var(--text)]">{email}</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <Badge tone="accent">{role.replace(/_/g, ' ')}</Badge>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="flex items-center gap-1 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)]"
              >
                <LogOut className="size-3" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-[var(--border)] px-4 sm:px-6">
          {/* Which system am I about to change? Stated permanently. */}
          <Badge tone={isProduction ? 'negative' : 'warning'}>
            {isProduction ? 'PRODUCTION' : environment.toUpperCase()}
          </Badge>
          <ThemeToggle />
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
