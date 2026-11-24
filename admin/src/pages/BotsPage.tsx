import { useState } from 'react';
import { AlertTriangle, Bot, PlayCircle, Search } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAsync, useDebounced } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Notice, PageHeader, Pagination, StatCard } from '../components/UI';
import { formatNumber, formatRelative } from '../lib/format';

interface BotSummary {
  generatedAt: number;
  bots: {
    total: number;
    imported: number;
    paused: number;
    archived: number;
    byCompatibility: Record<string, number>;
  };
  runs: { total: number; running: number; failed: number; stopped: number };
  safety: { accountMode: string; note: string };
}

interface ImportRow {
  id: string;
  userId: string;
  name: string;
  originalFilename: string;
  compatibility: 'full' | 'partial' | 'unsupported' | 'invalid';
  compatibilityReason: string;
  status: string;
  warnings: number;
  unknownBlocks: { type: string; count: number }[];
  revision: number;
  createdAt: number;
}

interface RunRow {
  runId: string;
  botId: string;
  userId: string;
  accountMode: string;
  runtimeStatus: string;
  startedAt: number;
  stoppedAt: number | null;
  lastEvaluationAt: number | null;
}

const PAGE_SIZE = 20;

function compatTone(c: string): string {
  if (c === 'full') return 'green';
  if (c === 'partial') return 'amber';
  if (c === 'unsupported') return 'red';
  return 'slate';
}

function runTone(s: string): string {
  if (s === 'running') return 'green';
  if (s === 'failed') return 'red';
  if (s === 'stopping') return 'amber';
  return 'slate';
}

export function BotsPage() {
  const [tab, setTab] = useState<'imports' | 'runs'>('imports');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [compat, setCompat] = useState('');
  const [runStatus, setRunStatus] = useState('');
  const q = useDebounced(search, 320);

  const summary = useAsync<BotSummary>(() => api.get('/bots/summary'), []);
  const imports = useAsync<{ items: ImportRow[]; total: number; page: number; pageSize: number; totalPages: number }>(
    () => api.get(`/bots/imports${qs({ page, pageSize: PAGE_SIZE, q, compatibility: compat })}`),
    [page, q, compat]
  );
  const runs = useAsync<{ items: RunRow[]; total: number; page: number; pageSize: number; totalPages: number }>(
    () => api.get(`/bots/runs${qs({ page, pageSize: PAGE_SIZE, status: runStatus })}`),
    [page, runStatus]
  );

  const s = summary.data;

  return (
    <>
      <PageHeader title="Bot Builder" subtitle="Imported DBot files and execution runs. Read-only operational visibility." />

      <Notice kind="info">
        <strong>Demo only.</strong> Imported bot runs refuse a real account outright. This console reports the
        compatibility verdict recorded at import time; it never upgrades an unsupported block to supported.
      </Notice>

      {summary.loading ? (
        <LoadingBlock />
      ) : s ? (
        <div className="grid grid-4 mb">
          <StatCard label="Imported bots" value={formatNumber(s.bots.total)} icon={<Bot size={14} />} hint={`${s.bots.imported} active`} />
          <StatCard
            label="Fully supported"
            value={formatNumber(s.bots.byCompatibility.full ?? 0)}
            tone="success"
            icon={<PlayCircle size={14} />}
            hint={`${s.bots.byCompatibility.partial ?? 0} partial · ${s.bots.byCompatibility.unsupported ?? 0} unsupported`}
          />
          <StatCard label="Runs" value={formatNumber(s.runs.total)} icon={<PlayCircle size={14} />} hint={`${s.runs.running} running`} />
          <StatCard label="Failed runs" value={formatNumber(s.runs.failed)} tone={s.runs.failed > 0 ? 'danger' : 'success'} icon={<AlertTriangle size={14} />} hint="Across all users" />
        </div>
      ) : null}

      <div className="row gap-sm mb">
        <button className={`btn ${tab === 'imports' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('imports'); setPage(1); }}>
          Imports
        </button>
        <button className={`btn ${tab === 'runs' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('runs'); setPage(1); }}>
          Execution runs
        </button>
      </div>

      {tab === 'imports' ? (
        <Card
          tight
          title="Imported bots"
          subtitle="Compatibility is the verdict recorded at import"
          actions={
            <div className="row gap-sm">
              <div className="input-search">
                <Search size={15} />
                <input
                  className="input"
                  placeholder="Search name or file"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  style={{ width: 220 }}
                />
              </div>
              <select className="select" value={compat} onChange={(e) => { setCompat(e.target.value); setPage(1); }} style={{ width: 150 }}>
                <option value="">All compatibility</option>
                <option value="full">Full</option>
                <option value="partial">Partial</option>
                <option value="unsupported">Unsupported</option>
                <option value="invalid">Invalid</option>
              </select>
            </div>
          }
        >
          {imports.loading ? (
            <LoadingBlock />
          ) : (imports.data?.items.length ?? 0) === 0 ? (
            <Empty title="No imported bots">Imports will appear here as users upload DBot XML files.</Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Bot</th>
                      <th>File</th>
                      <th>Compatibility</th>
                      <th>Unsupported blocks</th>
                      <th>Warnings</th>
                      <th>Imported</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imports.data!.items.map((b) => (
                      <tr key={b.id}>
                        <td className="strong">{b.name}</td>
                        <td className="tiny muted">{b.originalFilename}</td>
                        <td>
                          <Badge tone={compatTone(b.compatibility)}>{b.compatibility}</Badge>
                          <div className="tiny muted">{b.compatibilityReason}</div>
                        </td>
                        <td className="tiny">
                          {b.unknownBlocks.length === 0 ? (
                            <span className="muted">none</span>
                          ) : (
                            b.unknownBlocks.map((u) => `${u.type} ×${u.count}`).join(', ')
                          )}
                        </td>
                        <td className="num">{b.warnings}</td>
                        <td className="tiny muted">{formatRelative(b.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={imports.data!.page} pageSize={imports.data!.pageSize} total={imports.data!.total} totalPages={imports.data!.totalPages} onPage={setPage} />
            </>
          )}
        </Card>
      ) : (
        <Card
          tight
          title="Execution runs"
          subtitle="Every run is demo-mode by construction"
          actions={
            <select className="select" value={runStatus} onChange={(e) => { setRunStatus(e.target.value); setPage(1); }} style={{ width: 150 }}>
              <option value="">All statuses</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
              <option value="failed">Failed</option>
              <option value="idle">Idle</option>
            </select>
          }
        >
          {runs.loading ? (
            <LoadingBlock />
          ) : (runs.data?.items.length ?? 0) === 0 ? (
            <Empty title="No execution runs">Bot runs will appear here when a user starts one.</Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Bot</th>
                      <th>Mode</th>
                      <th>Status</th>
                      <th>Started</th>
                      <th>Stopped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.data!.items.map((r) => (
                      <tr key={r.runId}>
                        <td className="mono tiny">{r.runId.slice(0, 12)}…</td>
                        <td className="mono tiny">{r.botId.slice(0, 12)}…</td>
                        <td>
                          <Badge tone="slate">{r.accountMode}</Badge>
                        </td>
                        <td>
                          <Badge tone={runTone(r.runtimeStatus)}>{r.runtimeStatus}</Badge>
                        </td>
                        <td className="tiny muted">{formatRelative(r.startedAt)}</td>
                        <td className="tiny muted">{r.stoppedAt ? formatRelative(r.stoppedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={runs.data!.page} pageSize={runs.data!.pageSize} total={runs.data!.total} totalPages={runs.data!.totalPages} onPage={setPage} />
            </>
          )}
        </Card>
      )}
    </>
  );
}
