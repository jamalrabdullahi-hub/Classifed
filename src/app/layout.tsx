import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { currentUser } from '@/server/session';
import { LogoutButton } from '@/components/LogoutButton';

export const metadata: Metadata = {
  title: 'FLTCrypto',
  description: 'USD crypto brokerage',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  return (
    <html lang="en">
      <body>
        <header className="bar">
          <Link href={user ? '/dashboard' : '/'} className="brand" style={{ textDecoration: 'none' }}>
            FLTCrypto
          </Link>
          {user ? (
            <span className="row" style={{ gap: 10 }}>
              <span className="muted">{user.email}</span>
              <LogoutButton />
            </span>
          ) : null}
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
