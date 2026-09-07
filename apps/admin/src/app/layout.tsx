import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';
import { TooltipProvider } from '@flt/ui';
import { ThemeScript } from '@/components/theme';

// The same type system as the consumer app. An operator moving between the two
// should not be able to tell they are different codebases.
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

export const metadata: Metadata = {
  title: { default: 'FLT Admin', template: '%s · FLT Admin' },
  description: 'FLT-Exchange administration',
  // An admin panel has no business in a search index.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * The font variables go on <html>, not <body>.
     *
     * The design tokens that reference them are declared at :root, and a
     * custom property is resolved where it is declared — so a face defined one
     * level down on <body> is invisible to them and every token silently falls
     * back to the system stack.
     */
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen antialiased">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
