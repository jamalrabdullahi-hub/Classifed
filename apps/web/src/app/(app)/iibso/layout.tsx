import { TradingLock } from '@/components/trading-lock';
import { currentUser } from '@/server/session';

/** Spot trading: locked, with an explanation, for an account not approved to trade. */
export default async function TradeLayout({ children }: { children: React.ReactNode }) {
  return <TradingLock user={await currentUser()}>{children}</TradingLock>;
}
