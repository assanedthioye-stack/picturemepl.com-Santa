export const STAFF_ROLES = ['admin', 'supervisor', 'host', 'photographer', 'cashier'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
/** The kiosk screen is a device principal, never a person. */
export type Principal = StaffRole | 'kiosk';

/** Single source of truth for who may do what. Server middleware and UI both read this. */
export const PERMISSIONS = {
  'users.manage': ['admin'],
  'events.manage': ['admin'],
  'pricing.manage': ['admin'],
  'reports.view': ['admin', 'supervisor'],
  'audit.view': ['admin', 'supervisor'],
  'drawer.reconcile': ['admin', 'supervisor'],
  'refund.approve': ['admin', 'supervisor'],
  'queue.override': ['admin', 'supervisor'],
  'session.dispatch': ['admin', 'supervisor', 'host'],
  'session.shoot': ['admin', 'supervisor', 'photographer'],
  'camera.view': ['admin', 'supervisor', 'photographer'],
  'payment.take': ['admin', 'supervisor', 'cashier'],
  'print.create': ['admin', 'supervisor', 'cashier'],
  'print.view': ['admin', 'supervisor', 'cashier'],
  'kiosk.view': ['kiosk'],
  'kiosk.favorite': ['kiosk'],
} as const satisfies Record<string, readonly Principal[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(who: Principal, perm: Permission): boolean {
  return (PERMISSIONS[perm] as readonly Principal[]).includes(who);
}

/** Admins use a password (they reach cloud data); booth staff use a 4–6 digit PIN. */
export function validateSecret(role: StaffRole, secret: string): string | null {
  if (role === 'admin') return secret.length >= 10 ? null : 'admin_password_too_short';
  return /^\d{4,6}$/.test(secret) ? null : 'pin_must_be_4_to_6_digits';
}
