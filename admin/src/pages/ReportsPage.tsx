import { Download, FileText } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Card, Empty, LoadingBlock, PageHeader } from '../components/UI';
import { formatDateTime, formatNumber } from '../lib/format';

/**
 * Reports. Each report is generated on demand from live data and downloaded as
 * CSV or JSON. There is no scheduled/emailed reporting yet, which is stated.
 */
interface RegistrationRow {
  date: string;
  newUsers: number;
  totalUsers: number;
}

export function ReportsPage() {
  const users = useAsync<{ series: RegistrationRow[] }>(() => api.get('/analytics/users' + qs({ days: 90 })), []);

  function download(name: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toCsv(rows: RegistrationRow[]): string {
    const header = 'date,new_users,total_users';
    const lines = rows.map((r) => `${r.date},${r.newUsers},${r.totalUsers}`);
    return [header, ...lines].join('\n');
  }

  const rows = users.data?.series ?? [];

  return (
    <>
      <PageHeader title="Reports" subtitle="Generate and download data extracts." />

      <div className="notice notice-info mb-lg">
        <strong>Reporting scope. </strong>
        Reports are generated on demand from current data. Scheduled or emailed reports are not configured in this
        deployment.
      </div>

      <div className="grid grid-2">
        <Card title="User growth report" subtitle="Registrations by day, last 90 days">
          {users.loading ? (
            <LoadingBlock />
          ) : rows.length > 0 ? (
            <>
              <div className="row gap-sm mb">
                <span className="badge badge-blue">{formatNumber(rows.reduce((a, r) => a + r.newUsers, 0))} new users</span>
                <span className="badge badge-slate">{rows.length} days</span>
              </div>
              <div className="row gap-sm">
                <button className="btn btn-ghost btn-sm" onClick={() => download('user-growth.csv', toCsv(rows), 'text/csv')}>
                  <Download size={13} /> CSV
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => download('user-growth.json', JSON.stringify(rows, null, 2), 'application/json')}>
                  <Download size={13} /> JSON
                </button>
              </div>
            </>
          ) : (
            <Empty title="No data for this report" icon={<FileText size={22} />}>
              There are no registrations in the reporting window.
            </Empty>
          )}
        </Card>

        <Card title="Administrator activity report" subtitle="Audit events, last page">
          <div className="muted small mb">Full audit history is available on the Audit Log page, with filtering and export.</div>
          <div className="row gap-sm">
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const data = await api.get<{ items: unknown[] }>('/audit' + qs({ pageSize: 100, page: 1 }));
                download('audit-events.json', JSON.stringify(data.items, null, 2), 'application/json');
              }}
            >
              <Download size={13} /> Export latest 100
            </button>
          </div>
          <div className="tiny faint mt">Generated {formatDateTime(Date.now())}</div>
        </Card>
      </div>
    </>
  );
}
