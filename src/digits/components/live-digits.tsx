'use client';

/**
 * The real, functional Digits app (live WebSocket, real auth/trading), rendered
 * via DigitsView. Optionally takes a no-code `appConfig` to render the
 * configurable control styles/order. Shared by the deployed page and the editor
 * (/edit) so the editor preview is fully live.
 */

import { useEffect, useRef } from 'react';
import { useDigitsTrading } from '../hooks/use-digits-trading';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { reportCopyOnBuy } from '../lib/copy-mirror';
import { DigitsView } from './digits-view';
import type { DigitsAppConfig } from '../lib/app-config';

export function LiveDigits({
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
  appConfig?: DigitsAppConfig;
  editMode?: boolean;
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  rearrangeMode?: boolean;
  onReorder?: (order: DigitsAppConfig['order']) => void;
  /** Override the provider logo — used by the editor to show the previewed logo. */
  logoSrc?: string;
  appName?: string;
  showAppName?: boolean;
}) {
  const providerLogo = useLogoSrc();
  const logoSrc = logoSrcOverride ?? providerLogo;
  const { ws, isConnected, isExhausted, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  const trading = useDigitsTrading({
    ws,
    isConnected,
    isExhausted,
    isAuthenticated: !!auth.wsUrl,
    onAuthWSFailed: logout,
  });

  // Copy trading: when a Digits buy is confirmed, report it to the WickSentinel
  // copy engine so the master's connected followers mirror the trade. Best-effort
  // and idempotent per contract — a failed mirror never affects the trade.
  const lastMirroredRef = useRef<number | null>(null);
  useEffect(() => {
    const br = trading.buyResult;
    const account = auth.activeAccount;
    const symbol = trading.activeSymbol?.underlying_symbol;
    if (!br || !account || !symbol) return;
    if (lastMirroredRef.current === br.contractId) return;
    lastMirroredRef.current = br.contractId;
    const isEvenOdd = trading.contractMode === 'DIGITEVEN' || trading.contractMode === 'DIGITODD';
    void reportCopyOnBuy({
      accountId: account.account_id,
      symbol,
      contractType: trading.contractMode,
      contractFamily: 'digits',
      direction: 'NONE',
      duration: trading.duration,
      durationUnit: 't',
      stake: parseFloat(trading.stake) || 0,
      basis: 'stake',
      currency: 'USD',
      masterContractId: br.contractId,
      ...(isEvenOdd ? {} : { digit: trading.selectedDigit, barrier: String(trading.selectedDigit) }),
    });
  }, [
    trading.buyResult,
    trading.activeSymbol,
    trading.contractMode,
    trading.duration,
    trading.stake,
    trading.selectedDigit,
    auth.activeAccount,
  ]);

  return (
    <DigitsView
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
      currentTick={trading.currentTick}
      lastDigit={trading.lastDigit}
      digitStats={trading.digitStats}
      pipSize={trading.pipSize}
      tradeType={trading.tradeType}
      setTradeType={trading.setTradeType}
      contractMode={trading.contractMode}
      setContractMode={trading.setContractMode}
      selectedDigit={trading.selectedDigit}
      setSelectedDigit={trading.setSelectedDigit}
      stake={trading.stake}
      setStake={trading.setStake}
      duration={trading.duration}
      setDuration={trading.setDuration}
      durationLimits={trading.durationLimits}
      proposal={trading.proposal}
      isProposalLoading={trading.isProposalLoading}
      buyContract={trading.buyContract}
      isBuying={trading.isBuying}
      buyResult={trading.buyResult}
      buyError={trading.buyError}
      clearBuyResult={trading.clearBuyResult}
      appConfig={appConfig}
      editMode={editMode}
      onSelect={onSelect}
      selectedKey={selectedKey}
      rearrangeMode={rearrangeMode}
      onReorder={onReorder}
    />
  );
}
