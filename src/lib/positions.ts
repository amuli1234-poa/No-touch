import type { AccountMode, ExecutionContract } from './trade';

export interface ContractPnlSummary {
  accountId: string;
  currency: string;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  openProfit: number | null;
  realizedProfit: number | null;
  openProfitUnavailableCount: number;
  realizedProfitUnavailableCount: number;
}

/**
 * Produces P/L totals per account and currency. Missing profit values make that
 * total unavailable instead of turning incomplete data into a misleading sum.
 */
export function summarizeContracts(
  contracts: ExecutionContract[],
  mode: AccountMode
): ContractPnlSummary[] {
  const groups = new Map<string, ExecutionContract[]>();
  for (const contract of contracts) {
    if (contract.accountMode !== mode) continue;
    const key = `${contract.accountId}\u0000${contract.currency}`;
    const group = groups.get(key) ?? [];
    group.push(contract);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const open = group.filter((contract) => contract.status === 'open');
      const closed = group.filter((contract) => contract.status !== 'open');
      const knownOpenProfit = open.filter((contract) => contract.profit !== null);
      const knownRealizedProfit = closed.filter((contract) => contract.profit !== null);
      return {
        accountId: group[0].accountId,
        currency: group[0].currency,
        openCount: open.length,
        closedCount: closed.length,
        wins: closed.filter((contract) => contract.status === 'won').length,
        losses: closed.filter((contract) => contract.status === 'lost').length,
        openProfit:
          open.length > 0 && knownOpenProfit.length === open.length
            ? knownOpenProfit.reduce((sum, contract) => sum + contract.profit!, 0)
            : null,
        realizedProfit:
          closed.length > 0 && knownRealizedProfit.length === closed.length
            ? knownRealizedProfit.reduce((sum, contract) => sum + contract.profit!, 0)
            : null,
        openProfitUnavailableCount: open.length - knownOpenProfit.length,
        realizedProfitUnavailableCount: closed.length - knownRealizedProfit.length
      };
    })
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.currency.localeCompare(b.currency));
}
