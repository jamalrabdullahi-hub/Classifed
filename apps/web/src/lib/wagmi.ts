'use client';

import { base } from 'wagmi/chains';
import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';

/**
 * Wallet connectivity.
 *
 * Built directly on wagmi rather than on a connect-kit, for two reasons. The
 * interface is bespoke, and a third-party modal would be the one screen in the
 * product that looks like somebody else's. More importantly, wallet connection
 * is the moment a user is most exposed to phishing patterns, so it is worth
 * owning the copy and the visual treatment rather than inheriting them.
 *
 * `injected` covers MetaMask and every other extension through EIP-6963, which
 * wagmi discovers automatically — no per-wallet configuration and no hard-coded
 * list to go stale.
 */

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    injected({ shimDisconnect: true }),
    // WalletConnect needs a project id. Without one the connector is simply
    // absent rather than present and broken — a wallet option that fails on
    // click is worse than one that is not offered.
    ...(projectId
      ? [
          walletConnect({
            projectId,
            showQrModal: true,
            metadata: {
              name: 'FLT Exchange',
              description: 'Non-custodial DEX trading',
              url: typeof window !== 'undefined' ? window.location.origin : 'https://fltexchange.local',
              icons: [],
            },
          }),
        ]
      : []),
  ],
  transports: {
    [base.id]: http(),
  },
  ssr: true,
});

export const SUPPORTED_CHAIN = base;

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
