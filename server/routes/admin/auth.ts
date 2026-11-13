import { Router, type Request, type Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import type { AdminContext } from '../../lib/adminSession.js';
import { attachAdminSession, issueAdminSessionCookie, clearAdminSessionCookie, adminCookieOptions, resolveAdminSession } from '../../lib/adminSession.js';
import { parseCookies } from '../../lib/http.js';
import { seal, open, verifySigned } from '../../lib/crypto.js';
import { createOpaqueId, timingSafeEqual } from '../../lib/pkce.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../../admin/passwords.js';
import { verifyTotp, generateTotpSecret, totpUri, generateRecoveryCodes, hashCode } from '../../admin/totp.js';
import { effectivePermissions } from '../../admin/permissions.js';
import { writeAudit } from '../../services/admin/audit.js';
import { RateLimiter } from '../../services/admin/rateLimit.js';
import type { AdminSessionRecord, AdminUserRecord, AdminInvitationRecord, AdminPasswordResetRecord } from '../../admin/types.js';

/**
 * Administrator authentication (`/api/admin/v1/auth/*`).
 *
 * This is entirely separate from Deriv OAuth. Administrators authenticate with
 * an email + password, then a mandatory TOTP second factor. No public
 * registration endpoint exists: accounts are created by the bootstrap command
 * or by a Super Admin invitation.
 */

function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

/** Public shape of an administrator — never includes hashes or secrets. */
function publicAdmin(admin: AdminUserRecord) {
  return {
    id: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    role: admin.role,
    status: admin.status,
    extraPermissions: admin.extraPermissions,
    permissions: effectivePermissions(admin.role, admin.extraPermissions),
    mfaEnrolled: admin.mfa.enrolled,
    createdAt: admin.createdAt,
    lastLoginAt: admin.lastLoginAt
  };
}

function sha256Token(token: string): string {
  // Tokens are compared by hash so a leaked data file does not yield live tokens.
  return createHash('sha256').update(token).digest('base64url');
}

export function createAdminAuthRouter(ctx: AdminContext): Router {
  const { cfg, store } = ctx;
  const router = Router();

  const loginLimiter = new RateLimiter(cfg.admin.maxFailedLogins, cfg.admin.lockoutSeconds * 1000);
  const mfaLimiter = new RateLimiter(10, 5 * 60 * 1000);

  router.use(attachAdminSession(ctx));

  /** Creates a session record. `mfaPending` sessions cannot reach the API. */
  async function createSession(
    admin: AdminUserRecord,
    req: Request,
    res: Response,
    mfaPending: boolean
  ): Promise<AdminSessionRecord> {
    const now = Date.now();
    const session: AdminSessionRecord = {
      id: createOpaqueId(),
      adminId: admin.id,
      createdAt: now,
      expiresAt: now + (mfaPending ? cfg.admin.mfaPendingTtlSeconds : cfg.admin.sessionTtlSeconds) * 1000,
      lastSeenAt: now,
      revoked: false,
      mfaPending,
      csrfToken: randomBytes(32).toString('base64url'),
      ip: clientIp(req),
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null
    };
    await store.createAdminSession(session);
    const maxAge = mfaPending ? cfg.admin.mfaPendingTtlSeconds : cfg.admin.sessionTtlSeconds;
    issueAdminSessionCookie(ctx, res, session.id, maxAge);
    return session;
  }

  /** Reads the raw cookie even for MFA-pending sessions. */
  function pendingSession(req: Request): AdminSessionRecord | null {
    const raw = parseCookies(req.headers.cookie)[cfg.admin.cookieName];
    if (!raw) return null;
    const id = verifySigned(raw, cfg.session.secret, 'admin-cookie-sign');
    if (!id) return null;
    const session = store.getAdminSession(id);
    if (!session || session.revoked || session.expiresAt <= Date.now()) return null;
    return session;
  }

  /* ------------------------------- login -------------------------------- */

  router.post('/login', async (req: Request, res: Response) => {
    const body = (req.body ?? {});
    const email = normaliseEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `login:${clientIp(req)}:${email ?? 'unknown'}`;

    const limit = loginLimiter.hit(key);
    if (!limit.allowed) {
      await writeAudit(store, {
        action: 'admin.login.rate_limited',
        targetType: 'admin',
        targetId: email,
        sourceIp: clientIp(req),
        reason: 'Too many attempts'
      });
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds });
      return;
    }

    const admin = email ? store.getAdminByEmail(email) : null;
    // Always run a hash comparison so a missing account and a wrong password are
    // indistinguishable by timing.
    const ok = admin ? await verifyPassword(password, admin.passwordHash) : await verifyPassword(password, DUMMY_HASH);

    if (!admin || !ok) {
      await writeAudit(store, {
        action: 'admin.login.failed',
        targetType: 'admin',
        targetId: email,
        sourceIp: clientIp(req),
        metadata: { userAgent: req.headers['user-agent'] ?? null }
      });
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    if (admin.status === 'suspended') {
      await writeAudit(store, {
        actorAdminId: admin.id,
        actorEmail: admin.email,
        action: 'admin.login.suspended',
        targetType: 'admin',
        targetId: admin.id,
        sourceIp: clientIp(req)
      });
      res.status(403).json({ error: 'admin_suspended' });
      return;
    }

    loginLimiter.reset(key);

    // MFA enrolment path: first login after bootstrap/invitation.
    if (!admin.mfa.enrolled) {
      const secret = admin.mfa.secretSealed ? open(admin.mfa.secretSealed, cfg.session.secret) : null;
      if (!secret) {
        res.status(500).json({ error: 'mfa_not_initialised' });
        return;
      }
      await createSession(admin, req, res, true);
      await writeAudit(store, {
        actorAdminId: admin.id,
        actorEmail: admin.email,
        action: 'admin.mfa.enrolment_started',
        targetType: 'admin',
        targetId: admin.id,
        sourceIp: clientIp(req)
      });
      res.json({ mfaEnrollmentRequired: true, otpauthUri: totpUri(secret, admin.email) });
      return;
    }

    await createSession(admin, req, res, true);
    await writeAudit(store, {
      actorAdminId: admin.id,
      actorEmail: admin.email,
      action: 'admin.login.password_ok',
      targetType: 'admin',
      targetId: admin.id,
      sourceIp: clientIp(req)
    });
    res.json({ mfaRequired: true });
  });

  /* ---------------------------- MFA enrol ------------------------------- */

  router.post('/mfa/enroll', async (req: Request, res: Response) => {
    const session = pendingSession(req);
    if (!session || !session.mfaPending) {
      res.status(401).json({ error: 'admin_unauthorized' });
      return;
    }
    const limit = mfaLimiter.hit(`mfa:${session.adminId}`);
    if (!limit.allowed) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds });
      return;
    }
    const admin = store.getAdminById(session.adminId);
    if (!admin || admin.status !== 'active') {
      res.status(401).json({ error: 'admin_unauthorized' });
      return;
    }
    const body = (req.body ?? {});
    const secret = admin.mfa.secretSealed ? open(admin.mfa.secretSealed, cfg.session.secret) : null;
    if (!secret || !verifyTotp(secret, String(body.code ?? ''))) {
      await writeAudit(store, {
        actorAdminId: admin.id,
        actorEmail: admin.email,
        action: 'admin.mfa.enrolment_failed',
        targetType: 'admin',
        targetId: admin.id,
        sourceIp: clientIp(req)
      });
      res.status(401).json({ error: 'invalid_mfa_code' });
      return;
    }

    const recoveryCodes = generateRecoveryCodes();
    admin.mfa.enrolled = true;
    admin.mfa.enrolledAt = Date.now();
    admin.mfa.recoveryCodeHashes = recoveryCodes.map(hashCode);
    await store.upsertAdmin(admin);

    session.mfaPending = false;
    session.expiresAt = Date.now() + cfg.admin.sessionTtlSeconds * 1000;
    await store.updateAdminSession(session);
    issueAdminSessionCookie(ctx, res, session.id, cfg.admin.sessionTtlSeconds);

    await writeAudit(store, {
      actorAdminId: admin.id,
      actorEmail: admin.email,
      action: 'admin.mfa.enrolled',
      targetType: 'admin',
      targetId: admin.id,
      sourceIp: clientIp(req)
    });
    res.json({ admin: publicAdmin(admin), csrfToken: session.csrfToken, recoveryCodes });
  });

  /* ---------------------------- MFA verify ------------------------------ */

  router.post('/mfa/verify', async (req: Request, res: Response) => {
    const session = pendingSession(req);
    if (!session || !session.mfaPending) {
      res.status(401).json({ error: 'admin_unauthorized' });
      return;
    }
    const limit = mfaLimiter.hit(`mfa:${session.adminId}`);
    if (!limit.allowed) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds });
      return;
    }
    const admin = store.getAdminById(session.adminId);
    if (!admin || admin.status !== 'active') {
      res.status(401).json({ error: 'admin_unauthorized' });
      return;
    }
    const body = (req.body ?? {});
    const code = String(body.code ?? '').trim();
    const secret = admin.mfa.secretSealed ? open(admin.mfa.secretSealed, cfg.session.secret) : null;

    let verified = secret ? verifyTotp(secret, code) : false;
    let usedRecovery = false;
    if (!verified) {
      const hash = hashCode(code);
      const idx = admin.mfa.recoveryCodeHashes.findIndex((h) => timingSafeEqual(h, hash));
      if (idx !== -1) {
        verified = true;
        usedRecovery = true;
        admin.mfa.recoveryCodeHashes.splice(idx, 1); // single use
        await store.upsertAdmin(admin);
      }
    }
    if (!verified) {
      await writeAudit(store, {
        actorAdminId: admin.id,
        actorEmail: admin.email,
        action: 'admin.mfa.verify_failed',
        targetType: 'admin',
        targetId: admin.id,
        sourceIp: clientIp(req)
      });
      res.status(401).json({ error: 'invalid_mfa_code' });
      return;
    }

    session.mfaPending = false;
    session.expiresAt = Date.now() + cfg.admin.sessionTtlSeconds * 1000;
    await store.updateAdminSession(session);
    issueAdminSessionCookie(ctx, res, session.id, cfg.admin.sessionTtlSeconds);

    admin.lastLoginAt = Date.now();
    await store.upsertAdmin(admin);
    mfaLimiter.reset(`mfa:${admin.id}`);

    await writeAudit(store, {
      actorAdminId: admin.id,
      actorEmail: admin.email,
      action: usedRecovery ? 'admin.login.mfa_recovery' : 'admin.login.success',
      targetType: 'admin',
      targetId: admin.id,
      sourceIp: clientIp(req),
      metadata: { userAgent: req.headers['user-agent'] ?? null }
    });
    res.json({ admin: publicAdmin(admin), csrfToken: session.csrfToken });
  });

  /* ------------------------------- session ------------------------------ */

  router.get('/session', (req: Request, res: Response) => {
    const session = resolveAdminSession(ctx, req);
    if (!session) {
      res.status(401).json({ error: 'admin_unauthorized' });
      return;
    }
    const admin = store.getAdminById(session.adminId);
    if (!admin || admin.status !== 'active') {
      res.status(401).json({ error: 'admin_unauthorized' });
      return;
    }
    res.json({ admin: publicAdmin(admin), csrfToken: session.csrfToken });
  });

  /* ------------------------------- logout ------------------------------- */

  router.post('/logout', async (req: Request, res: Response) => {
    const session = resolveAdminSession(ctx, req);
    if (session) {
      await store.revokeAdminSessions(session.adminId);
      const admin = store.getAdminById(session.adminId);
      await writeAudit(store, {
        actorAdminId: session.adminId,
        actorEmail: admin?.email ?? null,
        action: 'admin.logout',
        targetType: 'admin',
        targetId: session.adminId,
        sourceIp: clientIp(req)
      });
    } else {
      // Still allow clearing a pending (pre-MFA) session.
      const pending = pendingSession(req);
      if (pending) {
        pending.revoked = true;
        await store.updateAdminSession(pending);
      }
    }
    clearAdminSessionCookie(ctx, res);
    res.status(204).end();
  });

  /* --------------------------- password reset --------------------------- */

  router.post('/password/reset-request', async (req: Request, res: Response) => {
    const body = (req.body ?? {});
    const email = normaliseEmail(body.email);
    const admin = email ? store.getAdminByEmail(email) : null;
    // Always 200 — never reveal whether an administrator account exists.
    if (admin && admin.status === 'active') {
      const token = createOpaqueId(32);
      const reset: AdminPasswordResetRecord = {
        id: `apr_${createOpaqueId(12)}`,
        adminId: admin.id,
        tokenHash: sha256Token(token),
        createdAt: Date.now(),
        expiresAt: Date.now() + cfg.admin.resetTtlSeconds * 1000,
        consumedAt: null
      };
      await store.createPasswordReset(reset);
      await writeAudit(store, {
        action: 'admin.password.reset_requested',
        targetType: 'admin',
        targetId: admin.id,
        sourceIp: clientIp(req)
      });
      // There is no configured transactional email provider (see audit doc).
      // In non-production the token is logged so an operator can complete the
      // flow; in production it must be delivered out-of-band by the operator.
      if (!cfg.isProduction) {
        console.log(`[admin] password reset token for ${admin.email}: ${token}`);
      }
      res.json({ ok: true, devToken: cfg.isProduction ? undefined : token });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/password/reset', async (req: Request, res: Response) => {
    const body = (req.body ?? {});
    const token = typeof body.token === 'string' ? body.token : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const reset = store.getPasswordResetByTokenHash(sha256Token(token));
    if (!reset || reset.consumedAt !== null || reset.expiresAt <= Date.now()) {
      res.status(400).json({ error: 'invalid_or_expired_token' });
      return;
    }
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) {
      res.status(400).json({ error: 'weak_password', reason: strength.reason });
      return;
    }
    const admin = store.getAdminById(reset.adminId);
    if (!admin) {
      res.status(400).json({ error: 'invalid_or_expired_token' });
      return;
    }
    admin.passwordHash = await hashPassword(newPassword);
    await store.upsertAdmin(admin);
    await store.consumePasswordReset(reset.id);
    // A password change invalidates every existing session.
    await store.revokeAdminSessions(admin.id);
    await writeAudit(store, {
      actorAdminId: admin.id,
      actorEmail: admin.email,
      action: 'admin.password.reset',
      targetType: 'admin',
      targetId: admin.id,
      sourceIp: clientIp(req)
    });
    res.json({ ok: true });
  });

  /* ------------------------- invitation accept -------------------------- */

  router.post('/invitation/accept', async (req: Request, res: Response) => {
    const body = (req.body ?? {});
    const token = typeof body.token === 'string' ? body.token : '';
    const invitation = store.getInvitationByTokenHash(sha256Token(token));
    if (!invitation || invitation.consumedAt !== null || invitation.expiresAt <= Date.now()) {
      res.status(400).json({ error: 'invalid_or_expired_invitation' });
      return;
    }
    const strength = validatePasswordStrength(String(body.password ?? ''));
    if (!strength.ok) {
      res.status(400).json({ error: 'weak_password', reason: strength.reason });
      return;
    }
    if (store.getAdminByEmail(invitation.email)) {
      res.status(409).json({ error: 'admin_exists' });
      return;
    }
    const secret = generateTotpSecret();
    const admin: AdminUserRecord = {
      id: `adm_${createOpaqueId(12)}`,
      email: invitation.email,
      displayName: String(body.displayName ?? '').trim() || invitation.email.split('@')[0],
      passwordHash: await hashPassword(String(body.password)),
      role: invitation.role,
      extraPermissions: invitation.extraPermissions,
      status: 'active',
      mfa: { enrolled: false, secretSealed: seal(secret, cfg.session.secret), enrolledAt: null, recoveryCodeHashes: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastLoginAt: null,
      createdBy: invitation.invitedBy
    };
    await store.upsertAdmin(admin);
    await store.consumeInvitation(invitation.id);
    await writeAudit(store, {
      actorAdminId: invitation.invitedBy,
      action: 'admin.invitation.accepted',
      targetType: 'admin',
      targetId: admin.id,
      newState: { email: admin.email, role: admin.role },
      sourceIp: clientIp(req)
    });
    res.json({ ok: true, otpauthUri: totpUri(secret, admin.email) });
  });

  return router;
}

/** A fixed scrypt hash used to equalise timing when the account is unknown. */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
