import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { TooltipProvider } from '@flt/ui';
import { ThemeScript } from '@/components/theme';

/**
 * Inter with tabular figures. `display: swap` so a slow font load shows text
 * rather than nothing — a blank balance is worse than an unstyled one.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const DESCRIPTION =
  'Non-custodial trading. Connect your own wallet, trade through decentralized exchanges, and keep custody of your assets.';

export const metadata: Metadata = {
  /*
   * Absolute URLs for the social card are resolved against this. Without it
   * Next emits a relative og:image, which every platform ignores.
   */
  metadataBase: new URL(process.env.WEB_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'FLT-Exchange',
    template: '%s · FLT-Exchange',
  },
  description: DESCRIPTION,
  applicationName: 'FLT-Exchange',
  // Still unlaunched. The card matters for links shared privately, indexing
  // does not.
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'FLT-Exchange',
    title: 'FLT-Exchange',
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'FLT-Exchange' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FLT-Exchange',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0c11' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className={`${inter.variable} min-h-screen antialiased`}>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
