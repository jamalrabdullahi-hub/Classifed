import type { Metadata, Viewport } from 'next';
import { Chakra_Petch, IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';
import { TooltipProvider } from '@flt/ui';
import { ThemeScript } from '@/components/theme';

// The same three faces as the consumer app. An operator moving between the two
// should not be able to tell they are different codebases.
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
const display = Chakra_Petch({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
  variable: '--font-display-face',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-mono-face',
});

export const metadata: Metadata = {
  title: { default: 'FLT Admin', template: '%s · FLT Admin' },
  description: 'FLT-Exchange administration',
  // An admin panel has no business in a search index.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body
        className={`${inter.variable} ${display.variable} ${mono.variable} min-h-screen antialiased`}
      >
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
