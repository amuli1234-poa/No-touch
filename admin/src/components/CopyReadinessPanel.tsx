import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, HelpCircle, PauseCircle, ShieldAlert } from 'lucide-react';
import type { CopyReadiness, CopyReadinessHealth } from '../lib/copyTrading';
import { Badge, Empty, LoadingBlock, Notice } from './UI';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';

/**
 * Copy Trading operational readiness.
 *
 * A read-only projection of persisted state. It answers "would a new DEMO master
 * trade be mirrored to anyone right now?" and shows the counts behind that
 * answer. It deliberately offers no controls: starting the engine is the
 * Start/Stop button in the parent panel, so this component can never initiate
 * copying.
 *
 * READY is rendered as "prerequisites met", never as "trading is live". The
 * server sends `guarantee: false`; the wording here keeps that promise visible.
 */

const STATE_COPY: Record<
  CopyReadiness['state'],
  { label: string; tone: string; icon: ReactNode; blurb: string }
> = {
  READY: {
    label: 'Ready',
    tone: 'green',
    icon: <CheckCircle2 size={16} />,
    blurb: 'Prerequisites are satisfied. This is not a guarantee that a future trade will execute.'
  },
  PAUSED: {
    label: 'Paused',
    tone: 'amber',
    icon: <PauseCircle size={16} />,
    blurb: 'Eligible clients exist, but copying is stopped. Nothing is mirrored until it is started.'
  },
  NO_FOLLOWERS: {
    label: 'No followers',
    tone: 'blue',
    icon: <CircleSlash size={16} />,
    blurb: 'No eligible client is connected, so there is nothing to copy to.'
  },
  AWAITING_AUTHORIZATION: {
    label: 'Awaiting authorization',
    tone: 'violet',
    icon: <Clock size={16} />,
    blurb: 'Invitations are outstanding. Copying stays off until a client finishes authorizing.'
  },
  DEGRADED: {
    label: 'Degraded',
    tone: 'red',
    icon: <ShieldAlert size={16} />,
    blurb: 'A health check is failing. Copies may fail or be skipped even with the switch on.'
  },
  UNKNOWN: {
    label: 'Unknown',
    tone: 'slate',
    icon: <HelpCircle size={16} />,
    blurb: 'Readiness could not be determined. Treat copying as not ready until this clears.'
  }
};

const ROSTER_COPY: Record<CopyReadiness['roster'], { label: string; tone: string }> = {
  EMPTY: { label: 'No client records', tone: 'blue' },
  ALL_HELD: { label: 'All clients held', tone: 'amber' },
  NONE_ELIGIBLE: { label: 'No eligible client', tone: 'amber' },
  AWAITING_AUTHORIZATION: { label: 'Awaiting authorization', tone: 'violet' },
  HAS_ELIGIBLE: { label: 'Eligible clients present', tone: 'green' },
  UNKNOWN: { label: 'Unknown', tone: 'slate' }
};

const SCOPE_LABEL: Record<'follower' | 'execution', string> = {
  follower: 'Client health',
  execution: 'Master execution health'
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" data-tone="blue">
      <span className="tiny muted">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="tiny muted">{hint}</span>}
    </div>
  );
}

function CheckRow({ check }: { check: CopyReadinessHealth }) {
  return (
    <div className="row gap-sm" style={{ alignItems: 'baseline' }}>
      <Badge tone={check.status === 'ok' ? 'green' : check.status === 'fail' ? 'red' : 'slate'}>
        {check.status === 'ok' ? 'OK' : check.status === 'fail' ? 'Fail' : 'Unknown'}
      </Badge>
      <span className="small">
        <strong>{check.key}</strong> — {check.detail}
      </span>
    </div>
  );
}

export function CopyReadinessPanel({
  readiness,
  loading,
  error
}: {
  readiness: CopyReadiness | null;
  loading: boolean;
  error: { code: string } | null;
}) {
  if (loading) return <LoadingBlock label="Checking copy trading readiness…" />;

  if (error) {
    return (
      <Empty title="Readiness could not be read" icon={<AlertTriangle size={22} />}>
        The backend did not answer ({error.code.replace(/_/g, ' ')}), so readiness is unknown rather than assumed.
      </Empty>
    );
  }

  if (!readiness) {
    return (
      <Empty title="No readiness data" icon={<HelpCircle size={22} />}>
        Select a master trader to see whether copy trading could run.
      </Empty>
    );
  }

  const copy = STATE_COPY[readiness.state];
  const roster = ROSTER_COPY[readiness.roster];
  const { counts, control, degraded } = readiness;
  const followerChecks = readiness.health.filter((c) => c.scope === 'follower');
  const executionChecks = readiness.health.filter((c) => c.scope === 'execution');

  return (
    <div className="col gap">
      <div className="row gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone={copy.tone}>{copy.label}</Badge>
        <Badge tone={roster.tone}>{roster.label}</Badge>
        <span className="small muted">{readiness.explanation}</span>
      </div>

      <p className="tiny muted" style={{ margin: 0 }}>
        {copy.blurb}
      </p>

      {degraded && (
        <Notice kind="danger" icon={<ShieldAlert size={16} />}>
          <div>
            <strong>Degraded by {degraded.summary.replace(/\.$/, '')}</strong>
          </div>
          {degraded.by.includes('follower') && (
            <div className="tiny" style={{ marginTop: 4 }}>
              Client-side: {degraded.follower.join(', ')} — fix the affected client’s authorization or DEMO account.
            </div>
          )}
          {degraded.by.includes('execution') && (
            <div className="tiny" style={{ marginTop: 4 }}>
              Master execution: {degraded.execution.join(', ')} — resolve this before copying resumes; it blocks READY
              even when every client is eligible.
            </div>
          )}
        </Notice>
      )}

      {!control.exists && (
        <Notice kind="warn">
          No Copy Trading switch is stored for this master. A missing switch is treated as stopped — it is never
          created or enabled automatically.
        </Notice>
      )}

      <div className="grid grid-4">
        <Metric
          label="Follower records"
          value={formatNumber(counts.followers)}
          hint={counts.followers === 0 ? 'None connected' : 'Connected to this master'}
        />
        <Metric
          label="Eligible now"
          value={formatNumber(counts.eligible)}
          hint={
            counts.followers === 0
              ? 'Nothing to copy to'
              : `${formatNumber(counts.held)} held · ${formatNumber(counts.disconnected)} disconnected`
          }
        />
        <Metric label="Held" value={formatNumber(counts.held)} hint="Paused or suspended by an admin" />
        <Metric label="Pending invitations" value={formatNumber(counts.pendingInvitations)} hint="Unconsumed and unexpired" />
        <Metric label="Disconnected" value={formatNumber(counts.disconnected)} hint="Fault, not an admin hold" />
        <Metric label="Eligible Deriv accounts" value={formatNumber(counts.eligibleDerivAccounts)} />
        <Metric
          label="Copy Trading switch"
          value={control.enabled ? 'Started' : 'Paused'}
          hint={control.updatedAt ? `Changed ${formatDateTime(control.updatedAt)}` : 'Never started'}
        />
        <Metric
          label="Last successful copy"
          value={readiness.lastCopy ? formatRelative(readiness.lastCopy.at) : '—'}
          hint={
            readiness.lastCopy
              ? `${readiness.lastCopy.accountId ?? 'account'} · contract ${readiness.lastCopy.contractId ?? '—'}`
              : 'No copied trade recorded'
          }
        />
        <Metric
          label="Last failure"
          value={readiness.lastFailure ? formatRelative(readiness.lastFailure.at) : '—'}
          hint={readiness.lastFailure ? (readiness.lastFailure.reason ?? 'unknown reason').replace(/_/g, ' ') : 'None recorded'}
        />
      </div>

      <div className="col gap-sm">
        <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {SCOPE_LABEL.follower}
        </span>
        {followerChecks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </div>

      <div className="col gap-sm">
        <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {SCOPE_LABEL.execution}
        </span>
        <p className="tiny muted" style={{ margin: 0 }}>
          These belong to the master’s own trading ledger, not to any client. A failure here keeps the state out of
          Ready even when every client is eligible.
        </p>
        {executionChecks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </div>

      {readiness.lastFailure && Object.keys(readiness.lastFailure.detail).length > 0 && (
        <details>
          <summary className="small muted">Last failure detail (secrets redacted)</summary>
          <pre className="tiny" style={{ overflowX: 'auto' }}>
            {JSON.stringify(readiness.lastFailure.detail, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
