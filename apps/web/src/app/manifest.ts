import type { MetadataRoute } from 'next';
import { getTranslations } from 'next-intl/server';

/**
 * Web app manifest.
 *
 * Installed to a home screen the product is a trading application, so it opens
 * standalone and portrait — a browser chrome around a signing flow invites the
 * address-bar confusion that phishing depends on.
 *
 * `maskable` is a separate file rather than the same PNG reused: Android crops
 * icons to a circle, and the standard icon's corners would lose the outer bar.
 *
 * The description follows the resolved locale like every other metadata
 * surface — Somali by default.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations('meta');

  return {
    name: 'FLT-Exchange',
    short_name: 'FLT',
    description: t('rootDescription'),
    start_url: '/dashboard',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0c11',
    theme_color: '#0a0c11',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
