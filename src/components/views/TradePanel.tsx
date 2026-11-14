import React from 'react';
import { BadgeCheck, Info, Lock, Send, ShieldCheck, Wallet } from 'lucide-react';
import type { ActiveSymbol, OpportunitySignal, WhatsAppProviderStatus } from '../../types/scanner';
import { Card, CardHeader, CardBody } from '../ui/Card';
import { Badge, StatusDot } from '../ui/Badge';
import { formatPrice } from '../ui/format';
import { useAuth } from '../../lib/auth';
import type { Tone } from '../ui/format';

/**
 * Right-hand panel: the account and signal context for the selected market.
 *
 * Deliberately **not** an order ticket. WickSentinel is an advisory signal
 * engine — it has no stake sizing, no order placement and no automation of
 * trades, so this panel never offers controls it cannot honour. Fabricating a
 * stake box or an "execute" button would both misrepresent the product and
 * risk implying a capability that does not exist.
 *
 * The one automation the product does have is *alert* dispatch (WhatsApp),
 * which is a notification, not a trade. It is surfaced here as read-only state
 * so the distinction between "signal generated" and "trade placed" stays
 * unambiguous.
 */

interface TradePanelProps {
  activeSymbol?: ActiveSymbol;
  opportunity?: OpportunitySignal;
  waStatus: WhatsAppProviderStatus;
  alertsAutoSend: boolean;
}

export const TradePanel: React.FC<TradePanelProps> = ({
  activeSymbol,
  opportunity,
  waStatus,
  alertsAutoSend
}) => {
  const auth = useAuth();
  const digits = (activeSymbol?.pipSize ?? 0.01) < 0.01 ? 3 : 2;

  const accountLabel =
    auth.status === 'authenticated' ? auth.user.loginId || 'Deriv account' : 'Not connected';
  const demo = auth.status === 'authenticated' ? auth.user.demoAccounts : 0;
  const real = auth.status === 'authenticated' ? auth.user.realAccounts : 0;

  return (
    <div className="space-y-4">
      {/* Account */}
      <Card className="overflow-hidden p-0">
        <CardHeader title="Account" subtitle="Your Deriv connection" icon={<Wallet className="h-4 w-4" />} />
        <CardBody className="space-y-3 pt-0">
          {auth.status === 'authenticated' ? (
            <>
              <div className="flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 text-tint-teal" />
                <span className="truncate text-[13px] font-semibold text-fg-1">{accountLabel}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ModeTile label="Demo" count={demo} tone="info" />
                <ModeTile label="Real" count={real} tone="warning" />
              </div>
              <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-fg-5">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-tint-teal" />
                Connected through your own Deriv OAuth session. WickSentinel never holds your funds or
                places orders.
              </p>
            </>
          ) : (
            <div className="rounded-[var(--radius-md)] border border-dashed border-line bg-surface-deep px-3.5 py-4 text-center">
              <Lock className="mx-auto h-4 w-4 text-fg-5" />
              <p className="mt-1.5 text-[12px] font-semibold text-fg-3">No Deriv account connected</p>
              <p className="mt-1 text-[11px] leading-relaxed text-fg-5">
                Connect a Deriv account to identify demo and real modes. Scanning works without one.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Selected market + signal context */}
      <Card className="overflow-hidden p-0">
        <CardHeader
          title="Signal context"
          subtitle={activeSymbol?.displayName || 'No market selected'}
          icon={<Send className="h-4 w-4" />}
        />
        <CardBody className="space-y-3 pt-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Selected market</span>
            <span className="text-[12px] font-semibold text-fg-2">
              {activeSymbol?.displayName || '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Last price</span>
            <span className="tabular text-[12px] font-semibold text-fg-1">
              {activeSymbol?.lastQuote ? formatPrice(activeSymbol.lastQuote, digits) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Scanner signal</span>
            {opportunity ? (
              <Badge tone={opportunity.entryAndTp.confirmed ? 'success' : 'warning'}>
                {opportunity.entryAndTp.confirmed ? opportunity.riseFallLabel : 'WAIT'}
              </Badge>
            ) : (
              <Badge tone="neutral">No data</Badge>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Confluence</span>
            <span className="tabular text-[12px] font-semibold text-fg-2">
              {opportunity ? `${opportunity.score.total}%` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Strategy</span>
            <span className="max-w-[60%] truncate text-right text-[12px] font-semibold text-fg-2">
              {opportunity?.entryAndTp.confirmed ? opportunity.selectedStrategy.label : '—'}
            </span>
          </div>
        </CardBody>
      </Card>

      {/* Alert automation — the only automation that exists. */}
      <Card className="overflow-hidden p-0">
        <CardHeader title="Alert automation" subtitle="Notifications, not trades" icon={<Send className="h-4 w-4" />} />
        <CardBody className="space-y-2.5 pt-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Dispatch channel</span>
            <StatusDot
              tone={waStatus.configured ? 'success' : 'neutral'}
              label={waStatus.configured ? waStatus.provider || 'Configured' : 'Not configured'}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-5">Auto-send on signal</span>
            <Badge tone={alertsAutoSend ? 'success' : 'neutral'}>
              {alertsAutoSend ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <p className="text-[10.5px] leading-relaxed text-fg-5">
            {waStatus.configured
              ? 'Alerts notify you of a confirmed setup. They never place an order.'
              : 'Configure a provider in Settings to receive signal alerts.'}
          </p>
        </CardBody>
      </Card>

      {/* Advisory notice — states the execution boundary plainly. */}
      <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-accent/25 bg-accent/8 px-3.5 py-3">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-soft" />
        <p className="text-[11px] leading-relaxed text-fg-4">
          <strong className="text-fg-2">Advisory only.</strong> WickSentinel generates and explains
          signals. It does not size positions, place orders or automate trading on any account. Every
          decision and trade remains yours, on your own Deriv account.
        </p>
      </div>
    </div>
  );
};

const ModeTile: React.FC<{ label: string; count: number; tone: Tone }> = ({ label, count, tone }) => (
  <div className="rounded-[var(--radius-md)] border border-line-soft bg-surface-deep px-2.5 py-2">
    <span className="block text-[9.5px] font-semibold uppercase tracking-[0.1em] text-fg-6">
      {label}
    </span>
    <span className="mt-0.5 flex items-baseline gap-1">
      <span className="tabular text-[16px] font-bold text-fg-1">{count}</span>
      <span className="text-[10px] text-fg-5">{count === 1 ? 'account' : 'accounts'}</span>
    </span>
    <span className="mt-1 block">
      <StatusDot tone={count > 0 ? tone : 'neutral'} label={count > 0 ? 'Available' : 'None'} />
    </span>
  </div>
);
