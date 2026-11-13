import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { fail, auditFromRequest } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import type { FeatureFlagRecord } from '../../admin/types.js';

/**
 * Platform configuration (`/api/admin/v1/configuration/*`).
 *
 * Ordinary product configuration only. Nothing here can alter trading risk
 * controls, entry limits, account-mode validation or the scanner engines — those
 * are deliberately out of scope for the admin surface.
 */

export function createConfigurationRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  router.get('/', requireAdmin(ctx, 'configuration.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({
      config: store.getPlatformConfig(),
      featureFlags: store.listFeatureFlags(),
      // Explicitly out of scope — surfaced so the UI can state it plainly.
      protectedControls: [
        'maxEntriesPerCandle (trading safety)',
        'account-mode validation',
        'scanner engine scoring thresholds',
        'Deriv OAuth scopes and credentials'
      ]
    });
  });

  router.patch('/', requireAdmin(ctx, 'configuration.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const current = store.getPlatformConfig();
    const previous = { ...current };

    if (req.body?.maintenanceMode !== undefined) current.maintenanceMode = Boolean(req.body.maintenanceMode);
    if (req.body?.registrationOpen !== undefined) current.registrationOpen = Boolean(req.body.registrationOpen);
    if (req.body?.supportEmail !== undefined) {
      const email = req.body.supportEmail === null ? null : String(req.body.supportEmail).trim();
      if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'invalid_support_email');
      current.supportEmail = email;
    }
    current.updatedBy = req.admin!.id;
    current.updatedAt = Date.now();
    await store.setPlatformConfig(current);

    await auditFromRequest(ctx, req, {
      action: 'configuration.updated',
      targetType: 'platform_config',
      targetId: 'singleton',
      previousState: previous,
      newState: { ...current },
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
    });
    return res.json({ config: current });
  });

  router.put('/feature-flags/:key', requireAdmin(ctx, 'configuration.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const key = String(req.params.key).trim();
    if (!/^[a-z0-9_.-]{2,64}$/i.test(key)) return fail(res, 400, 'invalid_flag_key');

    const existing = store.getFeatureFlag(key);
    const flag: FeatureFlagRecord = {
      key,
      label: String(req.body?.label ?? existing?.label ?? key).slice(0, 120),
      description: String(req.body?.description ?? existing?.description ?? '').slice(0, 500),
      enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : (existing?.enabled ?? false),
      updatedBy: req.admin!.id,
      updatedAt: Date.now()
    };
    await store.upsertFeatureFlag(flag);

    await auditFromRequest(ctx, req, {
      action: 'configuration.feature_flag.updated',
      targetType: 'feature_flag',
      targetId: key,
      previousState: existing ? { enabled: existing.enabled } : null,
      newState: { enabled: flag.enabled }
    });
    return res.json({ flag });
  });

  return router;
}
