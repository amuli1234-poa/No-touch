'use client';

/**
 * The real, functional Accumulators app (live WebSocket, real auth/trading),
 * rendered via AccumulatorView. Optionally takes a no-code `appConfig` to render
 * the configurable control styles/order. Shared by the deployed page and the
 * editor (/edit) so the editor preview is fully live.
 */

import { useEffect, useRef } from 'react';
import { useSmartChartsApi } from '@acc/hooks/use-smartcharts-api';
import { useSmartChartChartData } from '@acc/hooks/use-smartchart-chart-data';
import { useAccumulatorTrading } from '../hooks/use-accumulator-trading';
import { useDerivWSContext } from '@acc/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@acc/components/custom/logo-src-provider';
import { reportCopyOnBuy } from '../../lib/copy-mirror';
import { AccumulatorView } from './accumulator-view';
import type { AccumulatorsAppConfig } from '../lib/app-config';

export function LiveAccumulator({
  appConfig,
  editMode,
  onSelect,
  selectedKey,
  rearrangeMode,
  onReorder,
  logoSrc: logoSrcOverride,
  appName,
  showAppName,
}: {
  appConfig?: AccumulatorsAppConfig;
  editMode?: boolean;
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  rearrangeMode?: boolean;
  onReorder?: (order: AccumulatorsAppConfig['order']) => void;
  /** Override the provider logo — used by the editor to show the previewed logo. */
  logoSrc?: string;
  appName?: string;
  showAppName?: boolean;
}) {
  const providerLogo = useLogoSrc();
  const logoSrc = logoSrcOverride ?? providerLogo;
  const { ws, isConnected, isExhausted, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  const trading = useAccumulatorTrading({
    ws,
    isConnected,
    isExhausted,
    isAuthenticated: !!auth.wsUrl,
    onAuthWSFailed: logout,
  });

  const { chartData } = useSmartChartChartData(trading.ws, trading.isConnected, trading.symbols);
  const { getQuotes, subscribeQuotes, unsubscribeQuotes } = useSmartChartsApi(trading.ws);

  // Copy trading: mirror a confirmed Accumulator buy to the master's followers.
  const lastMirroredRef = useRef<number | null>(null);
  useEffect(() => {
    const br = trading.buyResult;
    const account = auth.activeAccount;
    const symbol = trading.activeSymbol?.underlying_symbol;
    if (!br || !account || !symbol) return;
    if (lastMirroredRef.current === br.contractId) return;
    lastMirroredRef.current = br.contractId;
    void reportCopyOnBuy({
      accountId: account.account_id,
      symbol,
      contractType: 'ACCU',
      contractFamily: 'accumulators',
      direction: 'NONE',
      duration: 0,
      durationUnit: 't',
      stake: parseFloat(trading.stake) || 0,
      basis: 'stake',
      currency: 'USD',
      masterContractId: br.contractId,
      barrier: String(trading.growthRate),
    });
  }, [trading.buyResult, trading.activeSymbol, trading.stake, trading.growthRate, auth.activeAccount]);

  return (
    <AccumulatorView
      authState={authState}
      accounts={accounts}
      activeAccount={activeAccount}
      onLogin={login}
      onSignUp={signUp}
      onLogout={logout}
      onSwitchAccount={switchAccount}
      logoSrc={logoSrc}
      appName={appName}
      showAppName={showAppName}
      isConnected={trading.isConnected}
      isLoading={trading.isLoading}
      error={trading.error}
      symbols={trading.symbols}
      activeSymbol={trading.activeSymbol}
      selectSymbol={trading.selectSymbol}
      prices={trading.prices}
      pipSize={trading.pipSize}
      growthRate={trading.growthRate}
      setGrowthRate={trading.setGrowthRate}
      growthRateOptions={trading.growthRateOptions}
      stake={trading.stake}
      setStake={trading.setStake}
      takeProfit={trading.takeProfit}
      setTakeProfit={trading.setTakeProfit}
      proposal={trading.proposal}
      buyContract={trading.buyContract}
      isBuying={trading.isBuying}
      buyResult={trading.buyResult}
      buyError={trading.buyError}
      clearBuyResult={trading.clearBuyResult}
      openPositions={trading.openPositions}
      sellContract={trading.sellContract}
      sellingId={trading.sellingId}
      chartData={chartData}
      getQuotes={getQuotes}
      subscribeQuotes={subscribeQuotes}
      unsubscribeQuotes={unsubscribeQuotes}
      appConfig={appConfig}
      editMode={editMode}
      onSelect={onSelect}
      selectedKey={selectedKey}
      rearrangeMode={rearrangeMode}
      onReorder={onReorder}
    />
  );
}
