/**
 * Granular admin permissions and role -> permission mapping.
 *
 * Authorization is always by permission, never by role-name comparison at the
 * call site. Roles are just named permission bundles; SUPPORT_AGENT does not get
 * session revocation by default (the spec says it is granted explicitly).
 */

export const PERMISSIONS = [
  'dashboard.read',
  'users.read',
  'users.suspend',
  'users.reactivate',
  'users.sessions.revoke',
  'users.notes.manage',
  'admins.read',
  'admins.invite',
  'admins.roles.manage',
  'admins.suspend',
  'admins.sessions.revoke',
  'subscriptions.read',
  'subscriptions.manage',
  'payments.read',
  'analytics.read',
  'revenue.read',
  'monitoring.read',
  'audit.read',
  'support.read',
  'support.manage',
  'announcements.read',
  'announcements.manage',
  'configuration.read',
  'configuration.manage',
  /* ------------------------ copy trading clients ------------------------ */
  'copytrading.read',
  'copytrading.onboard',
  'copytrading.authorize',
  'copytrading.followers.manage',
  'copytrading.risk.manage',
  'copytrading.control'
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_AGENT', 'ANALYST'] as const;
export type Role = (typeof ROLES)[number];

/** Human-facing role metadata for the admin UI. */
export const ROLE_META: Record<Role, { label: string; description: string }> = {
  SUPER_ADMIN: {
    label: 'Super Admin',
    description: 'Complete administrative access, including administrators, configuration and audit.'
  },
  PLATFORM_ADMIN: {
    label: 'Platform Admin',
    description: 'Manages users, analytics, monitoring and approved platform configuration.'
  },
  FINANCE_ADMIN: {
    label: 'Finance Admin',
    description: 'Subscriptions, payments and revenue. No access to security policy or trading controls.'
  },
  SUPPORT_AGENT: {
    label: 'Support Agent',
    description: 'User lookup, support tickets and internal notes. Session revocation only when granted.'
  },
  ANALYST: {
    label: 'Analyst',
    description: 'Read-only access to analytics, monitoring and reports.'
  }
};

/**
 * Default permission bundle per role. Explicit so the whole authorization
 * surface can be reviewed in one place.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,

  PLATFORM_ADMIN: [
    'dashboard.read',
    'users.read',
    'users.suspend',
    'users.reactivate',
    'users.sessions.revoke',
    'users.notes.manage',
    'analytics.read',
    'monitoring.read',
    'support.read',
    'support.manage',
    'announcements.read',
    'announcements.manage',
    'configuration.read',
    'configuration.manage',
    'copytrading.read',
    'copytrading.onboard',
    'copytrading.authorize',
    'copytrading.followers.manage',
    'copytrading.control'
  ],

  FINANCE_ADMIN: [
    'dashboard.read',
    'users.read',
    'subscriptions.read',
    'subscriptions.manage',
    'payments.read',
    'revenue.read',
    'analytics.read',
    'copytrading.read'
  ],

  SUPPORT_AGENT: [
    'dashboard.read',
    'users.read',
    'users.notes.manage',
    'support.read',
    'support.manage',
    'copytrading.read'
  ],

  ANALYST: [
    'dashboard.read',
    'analytics.read',
    'monitoring.read',
    'revenue.read',
    'audit.read',
    'copytrading.read'
  ]
};

/** Effective permissions = role bundle plus explicitly granted extras. */
export function effectivePermissions(role: Role, extraGrants: readonly string[] = []): Permission[] {
  const set = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
  for (const g of extraGrants) set.add(g);
  return [...set].filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
}

export function roleHasPermission(role: Role, permission: Permission, extraGrants: readonly string[] = []): boolean {
  return effectivePermissions(role, extraGrants).includes(permission);
}
