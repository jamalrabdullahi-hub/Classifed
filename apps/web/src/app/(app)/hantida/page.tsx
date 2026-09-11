import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  SectionHeader,
  Stat,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { Decimal, formatUsd } from '@flt/core/domain';
import { custodyPortfolio } from '@flt/core/services/portfolio-usd';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titlePortfolio') };
}
export const dynamic = 'force-dynamic';

/**
 * Portfolio.
 *
 * The balance is read from the custody ledger, not the chain: under custody the
 * funds are pooled in the omnibus, so what a participant holds is what FLT owes
 * them, and reading a wallet would show nothing. The chain is consulted only to
 * price the assets, and that value is labelled an estimate — see
 * `custodyPortfolio`.
 *
 * Three kinds of number stay visually distinct, as the brief requires: the
 * balance (exact, from the ledger), the estimated fiat value (a third-party
 * price applied to it), and a holding we could not price (shown as "—", never
 * as zero).
 */
export default async function PortfolioPage() {
  const user = await requireUserPage();
  const t = await getTranslations('pages.portfolio');

  const portfolio = await custodyPortfolio(user.id);

  if (portfolio.holdings.length === 0) {
    return (
      <div className="space-y-6">
        <SectionHeader title={t('title')} description={t('description')} />
        <Card>
          <EmptyState title={t('noBalancesTitle')} description={t('noBalancesBody')} />
        </Card>
      </div>
    );
  }

  const anyIncomplete = portfolio.holdings.some((holding) => !holding.complete);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />

      <div className="grid gap-5 sm:grid-cols-3">
        <Card>
          <CardContent>
            <Stat
              label={t('estimatedValue')}
              value={formatUsd(portfolio.totalUsd)}
              hint={anyIncomplete ? t('incompleteHint') : t('thirdPartyPricesHint')}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stat
              label={t('buyingPower')}
              value={formatUsd(portfolio.buyingPowerUsd)}
              hint={t('buyingPowerHint')}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stat label={t('assetsHeld')} value={portfolio.holdings.length} hint={t('nonZeroHint')} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('holdings')}</CardTitle>
          <Badge tone="neutral">{t('custodyBadge')}</Badge>
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>{t('asset')}</TH>
              <TH numeric>{t('balance')}</TH>
              <TH numeric>{t('price')}</TH>
              <TH numeric>{t('estimatedValue')}</TH>
            </TR>
          </THead>
          <TBody>
            {portfolio.holdings.map((holding) => (
              <TR key={holding.asset}>
                <TD>
                  <span className="font-medium">{holding.asset}</span>
                  {holding.name ? (
                    <span className="block text-[11px] text-[var(--text-subtle)]">{holding.name}</span>
                  ) : null}
                </TD>
                <TD numeric>
                  {formatHolding(
                    new Decimal(holding.available).plus(holding.locked).toFixed(),
                    holding.decimals,
                  )}
                </TD>
                <TD numeric>{formatUsd(holding.priceUsd)}</TD>
                <TD numeric>
                  {holding.valueUsd ? (
                    formatUsd(holding.valueUsd)
                  ) : (
                    <span className="text-[var(--text-subtle)]" title={t('couldNotBeRead')}>
                      —
                    </span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">{t('footerNote')}</p>
    </div>
  );
}

/** The ledger stores whole units, so this only trims, it does not rescale. */
function formatHolding(amount: string, decimals: number | null): string {
  try {
    const value = new Decimal(amount);
    const places = decimals !== null ? Math.min(decimals, 8) : 8;
    return value.toDecimalPlaces(places).toFixed();
  } catch {
    return amount;
  }
}
