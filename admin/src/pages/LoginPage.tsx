import { useState, type FormEvent } from 'react';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { api, ApiError, setCsrfToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AdminIdentity } from '../lib/api';

/**
 * Administrator sign-in.
 *
 * Two steps: email + password, then a TOTP code. First-ever sign-in for a
 * freshly bootstrapped account shows the enrolment step, which reveals the
 * otpauth URI and the one-time recovery codes.
 */
type Stage = 'credentials' | 'mfa' | 'enroll';

export function LoginPage() {
  const { setAdmin, refresh } = useAuth();
  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ mfaRequired?: boolean; mfaEnrollmentRequired?: boolean; otpauthUri?: string }>(
        '/auth/login',
        { email, password }
      );
      setPassword('');
      if (res.mfaEnrollmentRequired) {
        setOtpauthUri(res.otpauthUri ?? null);
        setStage('enroll');
      } else {
        setStage('mfa');
      }
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (stage === 'enroll') {
        const res = await api.post<{ admin: AdminIdentity; csrfToken: string; recoveryCodes: string[] }>('/auth/mfa/enroll', { code });
        setCsrfToken(res.csrfToken);
        setRecoveryCodes(res.recoveryCodes);
        setAdmin(res.admin);
        return;
      }
      const res = await api.post<{ admin: AdminIdentity; csrfToken: string }>('/auth/mfa/verify', { code });
      setCsrfToken(res.csrfToken);
      setAdmin(res.admin);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-brand">
            <div className="sidebar-logo" aria-hidden>WS</div>
            <div>
              <div className="login-title">Save your recovery codes</div>
              <div className="login-sub">Each code works once if you lose your authenticator.</div>
            </div>
          </div>
          <div className="notice notice-warn mb">
            These codes are shown once. Store them in a password manager now.
          </div>
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-body mono" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </div>
          <button className="btn btn-primary btn-block" onClick={() => void refresh()}>
            I have saved my codes — continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={stage === 'credentials' ? submitCredentials : submitMfa}>
        <div className="login-brand">
          <div className="sidebar-logo" aria-hidden>WS</div>
          <div>
            <div className="login-title">WickSentinel Admin</div>
            <div className="login-sub">Platform control centre</div>
          </div>
        </div>

        {error && (
          <div className="notice notice-danger mb" role="alert">
            {error}
          </div>
        )}

        {stage === 'credentials' && (
          <>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn btn-primary btn-block" disabled={busy} type="submit">
              {busy ? <span className="spinner" /> : <Lock size={15} />}
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </>
        )}

        {stage === 'mfa' && (
          <>
            <div className="row gap-sm mb">
              <ShieldCheck size={16} color="var(--blue)" />
              <span className="small muted">Enter the 6-digit code from your authenticator app.</span>
            </div>
            <CodeField value={code} onChange={setCode} />
            <button className="btn btn-primary btn-block" disabled={busy} type="submit">
              {busy ? <span className="spinner" /> : <KeyRound size={15} />}
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              style={{ marginTop: 9 }}
              onClick={() => {
                setStage('credentials');
                setCode('');
                setError(null);
              }}
            >
              Back
            </button>
          </>
        )}

        {stage === 'enroll' && (
          <>
            <div className="notice notice-info mb">
              First sign-in: add this account to your authenticator app, then enter the code it shows.
            </div>
            {otpauthUri && (
              <div className="field">
                <label>Enrolment URI</label>
                <div className="card">
                  <div className="card-body mono small" style={{ wordBreak: 'break-all' }}>
                    {otpauthUri}
                  </div>
                </div>
                <span className="hint">Paste this into your authenticator if you cannot scan a QR code.</span>
              </div>
            )}
            <CodeField value={code} onChange={setCode} />
            <button className="btn btn-primary btn-block" disabled={busy} type="submit">
              {busy ? <span className="spinner" /> : <ShieldCheck size={15} />}
              {busy ? 'Confirming…' : 'Confirm enrolment'}
            </button>
          </>
        )}

        <p className="tiny faint" style={{ marginTop: 18, marginBottom: 0, textAlign: 'center' }}>
          Administrators authenticate separately from trader accounts.
        </p>
      </form>
    </div>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="code">Authentication code</label>
      <input
        id="code"
        className="input mono"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={11}
        placeholder="000000"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9a-zA-Z-]/g, ''))}
        required
        autoFocus
        style={{ letterSpacing: '0.28em', textAlign: 'center', fontSize: 18 }}
      />
      <span className="hint">A recovery code may be used instead.</span>
    </div>
  );
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invalid_credentials':
        return 'Email or password is incorrect.';
      case 'invalid_mfa_code':
        return 'That code is not valid. Check your authenticator and try again.';
      case 'rate_limited':
        return 'Too many attempts. Please wait a few minutes and try again.';
      case 'admin_suspended':
        return 'This administrator account is suspended.';
      case 'network_error':
        return 'Cannot reach the server. Is the backend running?';
      case 'mfa_not_initialised':
        // Bootstrap sealed the MFA secret with a different SESSION_SECRET than
        // the running server uses, so it cannot be decrypted.
        return 'This account cannot start MFA enrolment. Re-run the bootstrap command with the same SESSION_SECRET the server uses.';
      default:
        return `Sign-in failed (${err.code}). Check the server logs for details.`;
    }
  }
  return 'Sign-in failed. Please try again.';
}
