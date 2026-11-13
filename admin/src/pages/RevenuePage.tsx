import { Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Card, Empty, LoadingBlock, PageHeader, StatCard, UnavailableNote } from '../components/UI';

interface Revenue {
  currency: string | null;
  mrr: number | null;
  arr: number | null;
  series: unknown[];
  unavailable?: string;
}

/**
 * Revenue. Reported as unavailable because there is no payment gateway or
 * billing history in this deployment. Shown plainly rather than estimated.
 */
export function RevenuePage() {
  const revenue = useAsync<Revenue>(() => api.get('/subscriptions/revenue'), []);
  const payments = useAsync<{ items: unknown[]; unavailable?: string }>(() => api.get('/subscriptions/payments'), []);

  return (
    <>
      <PageHeader title="Revenue" subtitle="Recurring revenue and payment history." />

      <div className="grid grid-4 mb-lg">
        <StatCard label="MRR" value="Unavailable" unavailable tone="success" icon={<Wallet size={14} />} hint="No billing records" />
        <StatCard label="ARR" value="Unavailable" unavailable tone="success" icon={<Wallet size={14} />} hint="No billing records" />
        <StatCard label="ARPU" value="Unavailable" unavailable icon={<Wallet size={14} />} hint="No billing records" />
        <StatCard label="Failed payments" value="Unavailable" unavailable tone="danger" icon={<Wallet size={14} />} hint="No payment provider" />
      </div>

      {revenue.data?.unavailable && (
        <div className="mb-lg">
          <UnavailableNote text={revenue.data.unavailable} />
        </div>
      )}

      <div className="grid grid-2">
        <Card title="Revenue over time" subtitle="Monthly recurring revenue">
          {revenue.loading ? (
            <LoadingBlock />
          ) : (
            <Empty title="No revenue data" icon={<Wallet size={22} />}>
              Revenue charts populate automatically once a payment provider is connected.
            </Empty>
          )}
        </Card>

        <Card title="Payments" subtitle="Recent transactions" tight>
          {payments.loading ? (
            <LoadingBlock />
          ) : payments.data && payments.data.items.length > 0 ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>User</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody />
              </table>
            </div>
          ) : (
            <Empty title="No payments recorded">{payments.data?.unavailable ?? 'Payments will appear here.'}</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
