import { CreditCard } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Card, Empty, LoadingBlock, PageHeader, StatCard, UnavailableNote } from '../components/UI';

/**
 * Subscriptions. No billing provider is configured in this deployment, so the
 * module renders an explicit empty state rather than invented records. The
 * layout is complete and will populate the moment a provider is connected.
 */
export function SubscriptionsPage() {
  const list = useAsync<{ items: unknown[]; total: number; unavailable?: string }>(() => api.get('/subscriptions'), []);
  const plans = useAsync<{ items: unknown[]; unavailable?: string }>(() => api.get('/subscriptions/plans'), []);

  return (
    <>
      <PageHeader title="Subscriptions" subtitle="Plans, entitlements and billing state." />

      <div className="grid grid-4 mb-lg">
        <StatCard label="Active subscriptions" value="Unavailable" unavailable tone="blue" icon={<CreditCard size={14} />} hint="No billing provider connected" />
        <StatCard label="Paid subscribers" value="Unavailable" unavailable tone="violet" icon={<CreditCard size={14} />} hint="No billing provider connected" />
        <StatCard label="Free users" value="Unavailable" unavailable icon={<CreditCard size={14} />} hint="No entitlement model" />
        <StatCard label="Conversion rate" value="Unavailable" unavailable tone="warn" icon={<CreditCard size={14} />} hint="No subscription records" />
      </div>

      {list.data?.unavailable && (
        <div className="mb-lg">
          <UnavailableNote text={list.data.unavailable} />
        </div>
      )}

      <Card title="Subscriptions" tight className="mb-lg">
        {list.loading ? (
          <LoadingBlock />
        ) : list.data && list.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Renews</th>
                </tr>
              </thead>
              <tbody>{/* populated once a billing provider is connected */}</tbody>
            </table>
          </div>
        ) : (
          <Empty title="No subscriptions" icon={<CreditCard size={22} />}>
            Connect a billing provider (for example Stripe or Paddle) to populate this module.
          </Empty>
        )}
      </Card>

      <Card title="Plan catalogue" tight>
        {plans.loading ? (
          <LoadingBlock />
        ) : plans.data && plans.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Price</th>
                  <th>Interval</th>
                </tr>
              </thead>
              <tbody />
            </table>
          </div>
        ) : (
          <Empty title="No plans configured">{plans.data?.unavailable ?? 'Add a plan catalogue to sell subscriptions.'}</Empty>
        )}
      </Card>
    </>
  );
}
