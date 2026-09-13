import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * The links every footer carries: the Android app, the privacy policy, the
 * terms, and account deletion.
 *
 * One component rather than four copies, because Google Play checks that the
 * privacy policy and deletion pages are reachable, and a link that exists in
 * three footers and was forgotten in the fourth is the one a reviewer lands on.
 */
export async function LegalLinks() {
  const t = await getTranslations('footerLinks');

  const links = [
    { href: '/app', label: t('androidApp') },
    { href: '/privacy', label: t('privacy') },
    { href: '/terms', label: t('terms') },
    { href: '/delete-account', label: t('deleteAccount') },
  ];

  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-[var(--text-subtle)] underline-offset-2 hover:text-[var(--text)] hover:underline"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
