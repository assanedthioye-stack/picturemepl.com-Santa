/** Status order used by booth and cloud sync: a merge keeps the furthest-along status. */
export const STATUS_RANK: Record<'bookings' | 'orders' | 'payments', readonly string[]> = {
  bookings: ['pending_payment', 'confirmed', 'checked_in', 'in_session', 'shot_complete', 'completed', 'no_show', 'expired', 'cancelled'],
  orders: ['open', 'void', 'paid', 'part_refunded', 'refunded'],
  payments: ['pending', 'cancelled', 'failed', 'succeeded'],
};

export function furthest(table: keyof typeof STATUS_RANK, a: string, b: string): string {
  const r = STATUS_RANK[table];
  return r.indexOf(b) > r.indexOf(a) ? b : a;
}
