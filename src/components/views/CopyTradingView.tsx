import { useCallback, useEffect, useState } from 'react';
import { Activity, Check, Copy, KeyRound, Link2, LoaderCircle, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import {
  addCopyFollower,
  createCopyInvitation,
  disconnectCopyFollower,
  fetchCopyTradingStatus,
  listCopyFollowers,
  type CopyFollower
} from '../../lib/copyTrading';

type ConnectionMethod = 'link' | 'token';

export function CopyTradingView() {
  const [followers, setFollowers] = useState<CopyFollower[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [patConfigured, setPatConfigured] = useState(false);
  const [method, setMethod] = useState<ConnectionMethod>('link');
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextFollowers, status] = await Promise.all([listCopyFollowers(), fetchCopyTradingStatus()]);
      setFollowers(nextFollowers);
      setPatConfigured(status.patConfigured);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The connected accounts could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const generateInvite = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      setInvite(await createCopyInvitation());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The invitation link could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
    } catch {
      setError('Clipboard access is unavailable. Select and copy the invitation link manually.');
    }
  };

  const submitToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const follower = await addCopyFollower(token);
      setToken('');
      setNotice(`${follower.loginId ?? 'Client demo account'} connected successfully. The token was sealed on the server.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The Deriv token could not be validated.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (follower: CopyFollower) => {
    setBusy(true);
    setError(null);
    try {
      const result = await disconnectCopyFollower(follower.id);
      setFollowers((current) => current.filter((item) => item.id !== follower.id));
      setNotice(result.providerRevoked
        ? 'The account was removed. WickSentinel also requested revocation of its OAuth grant.'
        : 'The account was removed from WickSentinel. The client must revoke the PAT in Deriv token settings to invalidate it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The account could not be disconnected.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <Activity className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Managed demo accounts</p>
            <h1 className="mt-1 text-2xl font-bold text-ink">Copy Trading</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              Connect clients with a Deriv authorization link or paste a client’s trade-scoped Personal Access Token.
            </p>
          </div>
        </div>
      </header>

      {(error || notice) && (
        <div role={error ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${error ? 'border-danger/30 bg-danger/5 text-danger' : 'border-success/30 bg-success/5 text-success'}`}>
          {error ?? notice}
        </div>
      )}

      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Connect a client account">
          <button type="button" role="tab" aria-selected={method === 'link'} onClick={() => setMethod('link')} className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold ${method === 'link' ? 'border-accent bg-accent text-white' : 'border-line bg-elevated text-muted hover:text-ink'}`}>
            <Link2 className="h-4 w-4" /> Authorization link
          </button>
          <button type="button" role="tab" aria-selected={method === 'token'} onClick={() => setMethod('token')} className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold ${method === 'token' ? 'border-accent bg-accent text-white' : 'border-line bg-elevated text-muted hover:text-ink'}`}>
            <KeyRound className="h-4 w-4" /> Paste API token
          </button>
        </div>

        {method === 'link' ? (
          <div className="mt-5">
            <h2 className="text-base font-bold text-ink">Invite a client with Deriv authorization</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">Create a private, one-use link that expires in 24 hours. The client signs in to Deriv and approves access directly.</p>
            <button type="button" disabled={busy} onClick={() => void generateInvite()} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Create invite link
            </button>
            {invite && (
              <div className="mt-4 rounded-xl border border-line bg-elevated p-3">
                <label htmlFor="copy-trading-invite" className="text-xs font-semibold text-muted">Private, one-use invitation link</label>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input id="copy-trading-invite" readOnly value={invite.url} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink" />
                  <button type="button" onClick={() => void copyInvite()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-semibold text-ink hover:border-accent/50">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy link'}</button>
                </div>
                <p className="mt-2 text-[11px] text-muted">Expires {new Date(invite.expiresAt).toLocaleString()} · Share privately with the intended client.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-5">
            <h2 className="text-base font-bold text-ink">Paste a client’s Deriv PAT</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">Ask the client to create a token with the <strong className="text-ink">trade</strong> scope and provide it to you securely. WickSentinel validates it and stores it encrypted.</p>
            {!patConfigured && (
              <p role="alert" className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted">
                Token entry needs a separate PAT-type App ID configured on the server as <code className="text-ink">DERIV_PAT_APP_ID</code>. The existing sign-in App ID is OAuth-type.
              </p>
            )}
            <form onSubmit={(event) => void submitToken(event)} className="mt-4 space-y-2">
              <label htmlFor="copy-trading-pat" className="text-xs font-semibold text-muted">Deriv Personal Access Token</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input id="copy-trading-pat" type="password" autoComplete="off" spellCheck={false} required minLength={20} maxLength={4096} value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the client’s token" className="min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 py-2.5 text-sm text-ink placeholder:text-faint" />
                <button type="submit" disabled={busy || !patConfigured || !token.trim()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50">
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Validate & connect
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted">Only demo accounts are added in this first stage. Real accounts returned by the token are ignored. Never send tokens through chat or email.</p>
            </form>
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Connected demo accounts">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-ink">Connected demo accounts</h2>
            <p className="mt-0.5 text-xs text-muted">{followers.length} client {followers.length === 1 ? 'connection' : 'connections'}</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh connected accounts" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:text-ink disabled:opacity-50">
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
        {loading ? (
          <div className="rounded-xl border border-line bg-surface p-5 text-sm text-muted">Loading connected accounts…</div>
        ) : followers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface p-6 text-sm text-muted">No client demo accounts connected yet. Choose either connection method above.</div>
        ) : followers.map((follower) => (
          <article key={follower.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-ink">{follower.loginId ?? 'Deriv demo account'}</p>
                <p className="mt-1 text-xs text-muted">Connected by {follower.authMethod === 'pat' ? 'API token' : 'Deriv authorization link'}{follower.tokenExpiresAt > 0 ? ` · authorization expires ${new Date(follower.tokenExpiresAt).toLocaleDateString()}` : ''}</p>
              </div>
              <button type="button" disabled={busy} onClick={() => void disconnect(follower)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-muted hover:border-danger/40 hover:text-danger disabled:opacity-50"><Unlink className="h-3.5 w-3.5" /> Disconnect</button>
            </div>
            <ul className="mt-3 flex flex-wrap gap-2">
              {follower.accounts.map((account) => (
                <li key={account.accountId} className="inline-flex items-center gap-2 rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-xs text-ink">
                  <span>{account.accountId}</span><span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent">demo</span>{account.currency && <span className="text-muted">{account.currency}</span>}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <aside className="rounded-xl border border-warning/25 bg-warning/5 p-4 text-xs leading-relaxed text-muted">
        <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p><strong className="text-ink">Demo connection only.</strong> Both methods currently save demo accounts only; this stage does not place or copy trades. Removing a pasted PAT here forgets it from WickSentinel but does not revoke it at Deriv—the client must revoke that token in Deriv settings.</p></div>
      </aside>
    </div>
  );
}
