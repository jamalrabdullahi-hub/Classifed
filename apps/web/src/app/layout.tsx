import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getLocale, getTranslations } from 'next-intl/server';
import './globals.css';
import { TooltipProvider } from '@flt/ui';
import { ThemeScript } from '@/components/theme';
import { ReferralBanner } from '@/components/referral-banner';

/**
 * One type system, two cuts.
 *
 * IBM Plex Sans sets the interface and the headings; IBM Plex Mono sets every
 * figure, address and hash. They are the same design at different widths, which
 * is what a screen full of numbers next to prose actually wants — a price and
 * the sentence explaining it should look related, because they are.
 *
 * ## What this replaced, and why
 *
 * Inter ran the interface before. It is a fine face and it is also the default
 * everything reaches for, which makes an interface look assembled rather than
 * designed. Plex was drawn for technical and data contexts and has real
 * character in the a, the g and the squared terminals without being decorative.
 *
 * Chakra Petch set the headings and is gone. It is a squared techno face that
 * reads as gaming, which fights a product whose whole voice is stating the
 * honest number. It was there to carry the wordmark's character inland — but
 * the wordmark is Arkitech drawn as outlines in `Brand`, so it keeps its own
 * character regardless and nothing is lost.
 *
 * Headings are now the same face at a heavier weight. Weight and size carry the
 * hierarchy; a second family is not needed to say "this is a heading".
 *
 * `display: swap` throughout, so a slow font load shows text rather than
 * nothing — a blank balance is worse than an unstyled one.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans-face',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-mono-face',
});

/**
 * Metadata in the site's own language.
 *
 * `generateMetadata` rather than a static export because the description has
 * to follow the resolved locale (`resolveLocale` in `src/i18n/request.ts`) —
 * Somali by default, so a crawler or a bare link preview sees Somali copy
 * unless the visitor has explicitly switched to English. No mention of
 * perpetuals here by design: the metadata surface stays to the plain,
 * non-leveraged description of the product.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = await getTranslations('meta');
  const description = t('rootDescription');

  return {
    /*
     * Absolute URLs for the social card are resolved against this. Without it
     * Next emits a relative og:image, which every platform ignores.
     */
    metadataBase: new URL(process.env.WEB_APP_URL ?? 'http://localhost:3000'),
    title: {
      default: 'FLT-Exchange',
      template: '%s · FLT-Exchange',
    },
    description,
    applicationName: 'FLT-Exchange',
    // Still unlaunched. The card matters for links shared privately, indexing
    // does not.
    robots: { index: false, follow: false },
    openGraph: {
      type: 'website',
      locale,
      siteName: 'FLT-Exchange',
      title: 'FLT-Exchange',
      description,
      images: [{ url: '/og.png', width: 1200, height: 630, alt: t('ogAlt') }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'FLT-Exchange',
      description,
      images: ['/og.png'],
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0c11' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    /*
     * The font variables go on <html>, not <body>.
     *
     * The design tokens that reference them are declared at :root, and a
     * custom property is resolved where it is declared — so a face defined one
     * level down on <body> is invisible to them and every token silently falls
     * back to the system stack.
     *
     * `lang` follows the resolved locale (`resolveLocale` in
     * `src/i18n/request.ts`) rather than being hardcoded, so assistive tech and
     * the browser's own translate offer read Somali as Somali.
     */
    <html lang={locale} suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TooltipProvider>
            <ReferralBanner />
            {children}
          </TooltipProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
