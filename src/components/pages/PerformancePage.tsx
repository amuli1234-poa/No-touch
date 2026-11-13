import React, { useEffect, useMemo, useState } from 'react';
import { IndexedDbStorage, PerformanceAnalytics } from '../../services/IndexedDbStorage';
import { OpportunitySignal, PerformanceRecord } from '../../types/scanner';
import {
  Badge,
  BarChart,
  Button,
  Card,
  CardHeader,
  Donut,
  EmptyState,
  SectionTitle,
  SkeletonRows,
  Sparkline,
  StatCard,
  TONE_HEX
} from '../ui';
import { STATUS_LABEL, formatPercent, statusTone } from '../ui/format';
import {
  Award,
  Percent,
  Trash2,
  RefreshCw,
  Activity,
  TrendingUp,
  Target,
  ShieldCheck,
  Gauge,
  BarChart3,
  CircleSlash
} from 'lucide-react';

interface PerformancePageProps {
  storage: IndexedDbStorage;
  opportunities: Map<string, OpportunitySignal>;
  totalScans: number;
  lastScanTimestamp: number;
}

export const PerformancePage: React.FC<PerformancePageProps> = ({
  storage,
  opportunities,
  totalScans,
  lastScanTimestamp
}) => {
  const [analytics, setAnalytics] = useState<PerformanceAnalytics | null>(null);
  const [records, setRecords] = useState<PerformanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await storage.computeAnalytics();
      const raw = await storage.getAllPerformanceRecords();
      setAnalytics(data);
      setRecords(raw.reverse());
    } catch (e) {
      console.error('Failed to load performance analytics:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [storage]);

  const handleClearHistory = async () => {
    if (window.confirm('Clear all historical tracking records? This cannot be undone.')) {
      await storage.clearAll();
      loadData();
    }
  };

  /* Live session statistics derived from real in-memory scanner output */
  const session = useMemo(() => {
    const list = Array.from(opportunities.values());
    const qualified = list.filter((o) => o.status === 'QUALIFIED').length;
    const rejected = list.filter((o) => o.status === 'REJECTED').length;
    const scored = list.filter((o) => o.score.total > 0);
    const avgScore =
      scored.length > 0 ? scored.reduce((a, o) => a + o.score.total, 0) / scored.length : 0;
    const aligned = list.filter((o) => o.score.structureAlignment === 20).length;
    const alignmentRate = list.length > 0 ? (aligned / list.length) * 100 : 0;
    return { list, qualified, rejected, avgScore, alignmentRate, scored: scored.length };
  }, [opportunities]);

  /* Rejection reason frequency — aggregated from real rejection reasons */
  const rejectionReasons = useMemo(() => {
    const counts = new Map<string, number>();
    session.list.forEach((o) => {
      o.rejectionReasons.forEach((r) => counts.set(r, (counts.get(r) ?? 0) + 1));
    });
    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [session.list]);

  /* Score distribution across live scan results */
  const scoreDistribution = useMemo(() => {
    const buckets = [
      { label: '<60', min: 0, max: 60, tone: 'danger' as const },
      { label: '60-79', min: 60, max: 80, tone: 'warning' as const },
      { label: '80-89', min: 80, max: 90, tone: 'info' as const },
      { label: '90-100', min: 90, max: 101, tone: 'success' as const }
    ];
    return buckets.map((b) => ({
      label: b.label,
      tone: b.tone,
      value: session.list.filter((o) => o.score.total >= b.min && o.score.total < b.max).length
    }));
  }, [session.list]);

  /* Historical scan activity — grouped by settlement hour from real records */
  const activitySeries = useMemo(() => {
    if (records.length === 0) return [];
    const byHour = new Map<number, number>();
    records.forEach((r) => {
      const hour = new Date(r.detectedEpoch * 1000);
      hour.setMinutes(0, 0, 0);
      const key = hour.getTime();
      byHour.set(key, (byHour.get(key) ?? 0) + 1);
    });
    return Array.from(byHour.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(-12)
      .map(([epoch, count]) => ({
        label: new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        value: count
      }));
  }, [records]);

  const winRateSeries = useMemo(() => {
    if (records.length < 2) return [];
    const ordered = [...records].reverse();
    let wins = 0;
    return ordered.map((r, i) => {
      if (r.contractSettledWon) wins++;
      return { label: `#${i + 1}`, value: Math.round((wins / (i + 1)) * 100) };
    });
  }, [records]);

  const calibrationDonut = useMemo(() => {
    if (!analytics || analytics.totalSettled === 0) return null;
    return [
      { value: analytics.barrierSurvivalRate, tone: 'success' as const, label: 'Survived' },
      { value: analytics.actualTouchFrequency, tone: 'danger' as const, label: 'Touched' }
    ];
  }, [analytics]);

  if (isLoading || !analytics) {
    return (
      <div className="space-y-4">
        <SectionTitle eyebrow="Analytics" title="Performance & calibration" />
        <Card>
          <SkeletonRows rows={8} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionTitle
        eyebrow="Analytics"
        title="Performance & calibration"
        description="Out-of-sample results recorded from live path-dependent tick excursions and actual Deriv contract expirations — no look-ahead bias."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={loadData}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={handleClearHistory}
            >
              Reset history
            </Button>
          </div>
        }
      />

      {/* Session KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Total scans"
          value={totalScans}
          hint={lastScanTimestamp ? `Last ${new Date(lastScanTimestamp).toLocaleTimeString()}` : 'Not scanned'}
          tone="neutral"
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Qualified"
          value={session.qualified}
          hint="Current scan results"
          tone="success"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatCard
          label="Rejected"
          value={session.rejected}
          hint="Failed mandatory gates"
          tone="danger"
          icon={<CircleSlash className="h-4 w-4" />}
        />
        <StatCard
          label="Alignment rate"
          value={formatPercent(session.alignmentRate, 0)}
          hint="5m matches 2m"
          tone="info"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          label="Avg technical score"
          value={session.avgScore.toFixed(1)}
          hint={`Across ${session.scored} scored markets`}
          tone={session.avgScore >= 80 ? 'success' : 'warning'}
          icon={<Gauge className="h-4 w-4" />}
        />
        <StatCard
          label="Settled contracts"
          value={analytics.totalSettled}
          hint={`${analytics.totalLogged} logged`}
          tone="accent"
          icon={<Award className="h-4 w-4" />}
        />
      </div>

      {/* Outcome KPIs from persisted calibration engine */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Barrier survival rate"
          value={formatPercent(analytics.barrierSurvivalRate)}
          hint="Unbroken during lifetime"
          tone="success"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatCard
          label="Contract win rate"
          value={formatPercent(analytics.contractWinRate)}
          hint="Actual settlement outcome"
          tone="info"
          icon={<Percent className="h-4 w-4" />}
        />
        <StatCard
          label="Simulated net P/L ($10 stake)"
          value={`${analytics.netProfit >= 0 ? '+' : '-'}$${Math.abs(analytics.netProfit).toFixed(2)}`}
          hint="Based on Deriv ask vs payout"
          tone={analytics.netProfit >= 0 ? 'success' : 'danger'}
          icon={<Target className="h-4 w-4" />}
        />
        <StatCard
          label="Calibration status"
          value={analytics.totalSettled >= 30 ? 'Calibrated' : 'Collecting'}
          hint={
            analytics.totalSettled >= 30
              ? 'Sufficient sample'
              : `${30 - analytics.totalSettled} more settlements recommended`
          }
          tone={analytics.totalSettled >= 30 ? 'success' : 'warning'}
          icon={<Award className="h-4 w-4" />}
        />
      </div>

      {/* Visual analytics */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<BarChart3 className="h-4 w-4" />}
            title="Technical score distribution"
            subtitle="Live scan results by score band"
          />
          <div className="p-4">
            {session.list.length > 0 ? (
              <BarChart data={scoreDistribution} height={150} />
            ) : (
              <EmptyState title="No scan results yet" description="Score distribution appears after the first scan completes." />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={<Gauge className="h-4 w-4" />}
            title="Model probability calibration"
            subtitle="Predicted survival vs observed outcome"
          />
          <div className="space-y-3 p-4">
            {analytics.calibrationCurve.some((b) => b.count > 0) ? (
              analytics.calibrationCurve.map((bin) => (
                <div key={bin.bucket} className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-fg-3">
                      Predicted survival {bin.bucket}
                    </span>
                    <span className="tabular font-semibold text-success">
                      Observed {bin.actualSurvivalRate.toFixed(1)}%
                      <span className="ml-1.5 text-fg-5">({bin.count})</span>
                    </span>
                  </div>
                  <div className="relative h-2 overflow-hidden rounded-full bg-surface-deepest">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-accent-cyan/25"
                      style={{ width: `${bin.predictedProb}%` }}
                      title="Predicted"
                    />
                    <div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{ width: `${bin.actualSurvivalRate}%`, backgroundColor: TONE_HEX.info }}
                      title="Observed"
                    />
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                icon={<Gauge className="h-5 w-5" />}
                title="Calibration pending"
                description="Calibration populates as qualified opportunities run to expiry and settle against the live tick path."
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={<CircleSlash className="h-4 w-4" />}
            title="Top rejection reasons"
            subtitle="Most frequent mandatory gate failures"
          />
          <div className="p-4">
            {rejectionReasons.length > 0 ? (
              <div className="space-y-2.5">
                {rejectionReasons.map((r) => {
                  const max = rejectionReasons[0].count;
                  return (
                    <div key={r.reason} className="space-y-1">
                      <div className="flex items-start justify-between gap-3 text-[11.5px]">
                        <span className="text-fg-3">{r.reason}</span>
                        <span className="tabular shrink-0 font-semibold text-fg-4">{r.count}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-deepest">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(r.count / max) * 100}%`,
                            backgroundColor: TONE_HEX.danger
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                title="No rejections recorded"
                description="Rejection reasons from the current scan set will be summarised here."
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={<Award className="h-4 w-4" />}
            title="Survival vs touch"
            subtitle="Barrier outcome across settled contracts"
            actions={calibrationDonut ? <Badge tone="info">{analytics.totalSettled} settled</Badge> : undefined}
          />
          <div className="flex flex-col items-center gap-4 p-4 sm:flex-row sm:justify-around">
            {calibrationDonut ? (
              <>
                <Donut
                  segments={calibrationDonut}
                  centerValue={formatPercent(analytics.barrierSurvivalRate, 0)}
                  centerLabel="Survival"
                />
                <div className="space-y-3">
                  <LegendRow color={TONE_HEX.success} label="Survived" value={formatPercent(analytics.barrierSurvivalRate)} />
                  <LegendRow color={TONE_HEX.danger} label="Touched" value={formatPercent(analytics.actualTouchFrequency)} />
                  <div className="border-t border-line-soft pt-3">
                    <LegendRow
                      color={TONE_HEX.info}
                      label="Standard win rate"
                      value={formatPercent(analytics.resultsByMarketType.standardWinRate)}
                    />
                    <LegendRow
                      color={TONE_HEX.accent}
                      label="1-second win rate"
                      value={formatPercent(analytics.resultsByMarketType.oneSecWinRate)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <EmptyState
                title="No settled contracts yet"
                description="Outcome split appears once contracts expire and settle."
              />
            )}
          </div>
        </Card>
      </div>

      {/* Activity & trend */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<Activity className="h-4 w-4" />}
            title="Historical scanning activity"
            subtitle="Settled contracts grouped by hour"
          />
          <div className="p-4">
            {activitySeries.length > 0 ? (
              <BarChart data={activitySeries.map((a) => ({ label: a.label, value: a.value, tone: 'accent' as const }))} height={150} />
            ) : (
              <EmptyState title="No activity recorded" description="Activity history builds as contracts settle." />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={<TrendingUp className="h-4 w-4" />}
            title="Rolling win rate"
            subtitle="Cumulative win rate across settled contracts"
          />
          <div className="p-4">
            {winRateSeries.length > 0 ? (
              <>
                <Sparkline data={winRateSeries.map((w) => w.value)} tone="success" height={150} max={100} min={0} />
                <div className="mt-2 flex items-center justify-between text-[11px] text-fg-5">
                  <span>First settlement</span>
                  <span className="tabular text-fg-3">
                    Current {winRateSeries[winRateSeries.length - 1].value}%
                  </span>
                  <span>Latest</span>
                </div>
              </>
            ) : (
              <EmptyState title="Not enough data" description="Rolling win rate needs at least two settled contracts." />
            )}
          </div>
        </Card>
      </div>

      {/* Performance by expiry + market */}
      {analytics.resultsByExpiry.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Performance by expiry duration" subtitle="Win rate per contract horizon" />
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
              {analytics.resultsByExpiry.map((exp) => (
                <div key={exp.durationMinutes} className="rounded-[10px] border border-line-soft bg-surface-deep px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-fg-5">
                    {exp.durationMinutes}m horizon
                  </div>
                  <div className="tabular mt-1 text-[16px] font-bold text-fg-1">
                    {formatPercent(exp.winRate)}
                  </div>
                  <div className="text-[10px] text-fg-5">{exp.total} contracts</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Performance by market" subtitle="Top markets by settled volume" />
            <div className="space-y-2 p-4">
              {analytics.resultsByMarket
                .slice()
                .sort((a, b) => b.total - a.total)
                .slice(0, 5)
                .map((m) => (
                  <div key={m.symbol} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="truncate font-medium text-fg-2">{m.symbol}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="tabular text-fg-4">{m.total} trades</span>
                      <Badge tone={m.winRate >= 60 ? 'success' : m.winRate >= 40 ? 'warning' : 'danger'}>
                        {formatPercent(m.winRate, 0)}
                      </Badge>
                    </span>
                  </div>
                ))}
            </div>
          </Card>
        </div>
      )}

      {/* Audited contract log */}
      <Card className="overflow-hidden">
        <CardHeader
          title={`Audited contract log (${records.length} entries)`}
          subtitle="Every settled contract recorded from live outcomes"
        />
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[820px] border-collapse text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface-deepest text-[10px] uppercase tracking-[0.08em] text-fg-5">
              <tr className="border-b border-line">
                <th className="px-3 py-2.5 font-semibold">Time</th>
                <th className="px-3 py-2.5 font-semibold">Market</th>
                <th className="px-3 py-2.5 font-semibold">Direction</th>
                <th className="px-3 py-2.5 text-right font-semibold">Score</th>
                <th className="px-3 py-2.5 text-right font-semibold">Barrier</th>
                <th className="px-3 py-2.5 text-right font-semibold">Predicted touch</th>
                <th className="px-3 py-2.5 font-semibold">Outcome</th>
                <th className="px-3 py-2.5 text-right font-semibold">P / L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {records.length > 0 ? (
                records.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-surface-raised">
                    <td className="tabular px-3 py-2.5 text-fg-4">
                      {new Date(r.detectedEpoch * 1000).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-fg-1">{r.displayName}</span>
                        {r.is1s && (
                          <span className="rounded border border-accent/30 bg-accent/10 px-1 py-px text-[9px] font-bold text-accent-soft">
                            1s
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={r.direction === 'BULLISH' ? 'success' : 'danger'}>
                        {r.direction}
                      </Badge>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold text-fg-2">
                      {r.technicalScore}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-fg-3">
                      {r.barrierLevel.toFixed(3)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-fg-4">
                      {(r.predictedTouchProb * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={r.contractSettledWon ? 'success' : 'danger'}>
                        {r.contractSettledWon ? 'Won · survived' : 'Touched · lost'}
                      </Badge>
                    </td>
                    <td
                      className={`tabular px-3 py-2.5 text-right font-semibold ${
                        r.profit >= 0 ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {r.profit >= 0 ? '+' : '-'}${Math.abs(r.profit).toFixed(2)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      icon={<Award className="h-5 w-5" />}
                      title="No completed contracts recorded yet"
                      description="When qualified opportunities run to expiry, each settled outcome is logged here with its realised profit or loss."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

const LegendRow: React.FC<{ color: string; label: string; value: string }> = ({
  color,
  label,
  value
}) => (
  <div className="flex items-center justify-between gap-6 text-[12px]">
    <span className="flex items-center gap-2 text-fg-4">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
    <span className="tabular font-semibold text-fg-2">{value}</span>
  </div>
);
