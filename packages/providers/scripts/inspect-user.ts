/**
 * Read-only: everything about one account that matters for a custody issue —
 * their wallets (deposit address?), their ledger balances (buying power), their
 * deposit rows (did the sweep/credit happen?), and the ledger movements.
 *
 *   pnpm --filter @flt/providers exec tsx \
 *     --env-file-if-exists=../../apps/worker/.env scripts/inspect-user.ts <email-or-id>
 */
import { prisma } from '@flt/db';
import { Decimal } from '@flt/core/domain';

const WHO = process.argv[2];

const CREDIT_KINDS = new Set(['USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE']);
function natural(kind: string, balance: string): string {
  const v = new Decimal(balance.toString());
  return (CREDIT_KINDS.has(kind) ? v.negated() : v).toString();
}

async function main(): Promise<void> {
  const user = WHO
    ? await prisma.user.findFirst({
        where: { OR: [{ email: WHO }, { id: WHO }] },
        include: { wallets: true, kycProfile: true },
      })
    : null;

  if (!user) {
    const all = await prisma.user.findMany({ select: { email: true, id: true }, orderBy: { createdAt: 'asc' } });
    console.info(WHO ? `No user matching "${WHO}". Accounts:` : 'All accounts:');
    for (const u of all) console.info(`  ${u.email}  ${u.id}`);
    if (WHO) process.exitCode = 1;
    return;
  }

  console.info(`USER  ${user.email}`);
  console.info(`  id        ${user.id}`);
  console.info(`  status    ${user.accountStatus}  ·  kyc ${user.kycProfile?.status ?? 'NOT_STARTED'}`);

  console.info('\nWALLETS (the privy-embedded one is the deposit address):');
  if (user.wallets.length === 0) console.info('  (none)');
  for (const w of user.wallets) {
    console.info(
      `  chain ${String(w.chainId).padEnd(11)} ${w.address}  connector=${w.connector ?? '(linked)'}` +
        `  providerWalletId=${w.providerWalletId ?? '—'}  verified=${w.verifiedAt ? 'y' : 'n'}` +
        `  preferred=${w.isPreferred ? 'y' : 'n'}`,
    );
  }

  const accounts = await prisma.ledgerAccount.findMany({
    where: { userId: user.id },
    orderBy: [{ asset: 'asc' }, { kind: 'asc' }],
  });
  console.info('\nLEDGER BALANCES (natural sign; buying power = USER_AVAILABLE):');
  if (accounts.length === 0) console.info('  (none — nothing credited)');
  for (const a of accounts) {
    console.info(`  ${a.asset.padEnd(6)} ${a.kind.padEnd(15)} ${natural(a.kind, a.balance.toString()).padEnd(24)} (stored ${a.balance})`);
  }

  const deposits = await prisma.custodyDeposit.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  console.info('\nDEPOSITS (a normal deposit ends CREDITED):');
  if (deposits.length === 0) {
    console.info('  (none — the worker detected no inbound transfer to this account\'s deposit address)');
  }
  for (const d of deposits) {
    console.info(
      `  ${d.asset} ${d.amountBaseUnits}  status=${d.status}` +
        `  at ${d.depositAddress}` +
        `\n      depositTx ${d.depositTxHash}` +
        `\n      sweepTx   ${d.sweepTxHash ?? '—'}` +
        `\n      failure   ${d.failureReason ?? '—'}   createdAt ${d.createdAt.toISOString()}`,
    );
  }

  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: { in: accountIds } },
      orderBy: { id: 'desc' },
      take: 40,
    });
    const transferIds = [...new Set(entries.map((e) => e.transferId))];
    const transfers = await prisma.ledgerTransfer.findMany({ where: { id: { in: transferIds } } });
    const byId = new Map(transfers.map((t) => [t.id, t]));
    console.info('\nLEDGER MOVEMENTS for this account (newest first):');
    if (entries.length === 0) console.info('  (none)');
    for (const e of entries) {
      const t = byId.get(e.transferId);
      console.info(`  ${(t?.kind ?? '?').padEnd(16)} ${String(e.amount).padEnd(22)} ${t?.reference ?? '—'}`);
    }
  }

  const omnibusLedger = await prisma.ledgerAccount.findFirst({
    where: { kind: 'CLIENT_OMNIBUS' },
    orderBy: { asset: 'asc' },
  });
  console.info(
    `\n(For comparison, the platform CLIENT_OMNIBUS ${omnibusLedger?.asset ?? 'USDC'} ledger balance is ` +
      `${omnibusLedger ? natural('CLIENT_OMNIBUS', omnibusLedger.balance.toString()) : '0'}. ` +
      `On-chain is from scripts/custody-check.ts.)`,
  );
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
