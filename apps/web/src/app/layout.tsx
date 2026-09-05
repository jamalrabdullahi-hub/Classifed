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

export const metadata: Metadata = {
  title: {
    default: 'FLT Exchange',
    template: '%s · FLT Exchange',
  },
  description:
    'Non-custodial trading. Connect your own wallet, trade through decentralized exchanges, and keep custody of your assets.',
  robots: { index: false, follow: false },
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
