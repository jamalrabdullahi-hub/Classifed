import { provisionWalletsOnDemand } from '@flt/providers';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Creates this account's FLT wallet, and makes it the trading wallet.
 *
 * The signup path provisions automatically when that is switched on; this is
 * for everybody else — accounts that existed before the feature, and accounts
 * whose provisioning failed at signup and was swallowed there by design.
 *
 * Unlike the signup path it reports failures, because somebody who pressed a
 * button is owed the reason it did not work.
 *
 * It moves no money. The new wallet starts empty and the participant's own
 * wallets keep everything in them — what changes is which address future
 * quotes are prepared against.
 */
export const POST = handler(
  { rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'wallet-provision' } },
  async ({ user }) => {
    const result = await provisionWalletsOnDemand(user);

    return {
      created: result.created,
      alreadyExisted: result.alreadyExisted,
      address: result.evmAddress,
      solanaAddress: result.solanaAddress,
      note: result.alreadyExisted
        ? 'You already have an FLT wallet.'
        : 'Your FLT wallet is ready. It is empty until you send funds to it.',
    };
  },
);
