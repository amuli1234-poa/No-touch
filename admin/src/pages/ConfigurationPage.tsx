import { useState } from 'react';
import { Save, Settings, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAsync, useToast } from '../lib/hooks';
import { Badge, Card, LoadingBlock, Notice, PageHeader } from '../components/UI';
import { formatDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';

interface PlatformConfig {
  maintenanceMode: boolean;
  registrationOpen: boolean;
  supportEmail: string | null;
  updatedBy: string | null;
  updatedAt: number;
}

interface Flag {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  updatedAt: number;
}

interface ConfigResponse {
  config: PlatformConfig;
  featureFlags: Flag[];
  protectedControls: string[];
}

/**
 * Platform configuration. Ordinary product settings only. Trading-safety and
 * security controls are listed as protected and cannot be changed here.
 */
export function ConfigurationPage() {
  const { has } = useAuth();
  const { push } = useToast();
  const data = useAsync<ConfigResponse>(() => api.get('/configuration'), []);
  const [draft, setDraft] = useState<PlatformConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const config = draft ?? data.data?.config ?? null;
  const canManage = has('configuration.manage');

  async function save() {
    if (!config) return;
    setBusy(true);
    try {
      await api.patch('/configuration', {
        maintenanceMode: config.maintenanceMode,
        registrationOpen: config.registrationOpen,
        supportEmail: config.supportEmail
      });
      push('success', 'Configuration saved');
      data.reload();
      setDraft(null);
    } catch (err) {
      push('error', 'Could not save', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleFlag(flag: Flag, enabled: boolean) {
    try {
      await api.put(`/configuration/feature-flags/${flag.key}`, { enabled, label: flag.label, description: flag.description });
      push('success', `Feature ${enabled ? 'enabled' : 'disabled'}`);
      data.reload();
    } catch (err) {
      push('error', 'Could not update flag', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    }
  }

  return (
    <>
      <PageHeader
        title="Configuration"
        subtitle="Platform-wide settings and feature flags."
        actions={
          canManage &&
          draft && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              {busy ? <span className="spinner" /> : <Save size={15} />} Save changes
            </button>
          )
        }
      />

      {data.loading ? (
        <LoadingBlock />
      ) : config ? (
        <div className="col gap-lg">
          <Card title="Platform settings" subtitle="Applies to all users">
            <div className="col gap">
              <label className="row-between card" style={{ padding: '12px 16px', cursor: canManage ? 'pointer' : 'not-allowed' }}>
                <div>
                  <div className="strong">Maintenance mode</div>
                  <div className="tiny muted">Show a maintenance notice and pause non-administrative access.</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.maintenanceMode}
                  disabled={!canManage}
                  onChange={(e) => setDraft({ ...config, maintenanceMode: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                />
              </label>

              <label className="row-between card" style={{ padding: '12px 16px', cursor: canManage ? 'pointer' : 'not-allowed' }}>
                <div>
                  <div className="strong">Registration open</div>
                  <div className="tiny muted">Allow new users to create accounts.</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.registrationOpen}
                  disabled={!canManage}
                  onChange={(e) => setDraft({ ...config, registrationOpen: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                />
              </label>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>Support email</label>
                <input
                  className="input"
                  type="email"
                  placeholder="support@example.com"
                  value={config.supportEmail ?? ''}
                  disabled={!canManage}
                  onChange={(e) => setDraft({ ...config, supportEmail: e.target.value || null })}
                />
                <span className="hint">Shown to users who need to contact support.</span>
              </div>
            </div>

            {config.updatedAt > 0 && (
              <div className="tiny faint mt">
                Last changed {formatDateTime(config.updatedAt)}
                {config.updatedBy ? ` by ${config.updatedBy}` : ''}
              </div>
            )}
            {!canManage && <Notice kind="info">You have read-only access to configuration.</Notice>}
          </Card>

          <Card title="Feature flags" subtitle="Toggle product capabilities without a deploy" tight>
            {data.data && data.data.featureFlags.length > 0 ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Flag</th>
                      <th>Description</th>
                      <th>Updated</th>
                      <th className="right">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.featureFlags.map((f) => (
                      <tr key={f.key}>
                        <td>
                          <div className="strong mono small">{f.key}</div>
                          <div className="tiny muted">{f.label}</div>
                        </td>
                        <td className="small muted">{f.description || '—'}</td>
                        <td className="muted small">{formatDateTime(f.updatedAt)}</td>
                        <td className="right">
                          <label className="row gap-sm" style={{ justifyContent: 'flex-end', cursor: canManage ? 'pointer' : 'not-allowed' }}>
                            <input
                              type="checkbox"
                              checked={f.enabled}
                              disabled={!canManage}
                              onChange={(e) => void toggleFlag(f, e.target.checked)}
                            />
                            <Badge tone={f.enabled ? 'badge-green' : 'badge-slate'}>{f.enabled ? 'On' : 'Off'}</Badge>
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                <div className="empty-icon">
                  <Settings size={22} />
                </div>
                <div className="empty-title">No feature flags</div>
                <div className="empty-text">Flags created through the API appear here.</div>
              </div>
            )}
          </Card>

          <Card title="Protected controls" subtitle="Deliberately outside the admin surface">
            <Notice kind="violet" icon={<ShieldAlert size={16} />}>
              These settings affect trading safety and security. They cannot be changed from this console.
            </Notice>
            <div className="col gap-sm mt">
              {data.data?.protectedControls.map((c) => (
                <div key={c} className="row gap-sm">
                  <span className="badge badge-slate mono" style={{ fontSize: 10 }}>
                    LOCKED
                  </span>
                  <span className="small">{c}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <Notice kind="danger">Configuration could not be loaded.</Notice>
      )}
    </>
  );
}
