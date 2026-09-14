import { TradingLock } from '@/components/trading-lock';
import { currentUser } from '@/server/session';

/** Perpetuals: locked, with an explanation, for an account not approved to trade. */
export default async function PerpsLayout({ children }: { children: React.ReactNode }) {
  return <TradingLock user={await currentUser()}>{children}</TradingLock>;
}
