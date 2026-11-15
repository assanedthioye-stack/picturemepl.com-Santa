const PACKAGES = {
  essentiel: ['print_5x7', 'print_4x6', 'wallet'],
  famille: ['print_8x10', 'print_5x7', 'print_4x6', 'wallet'],
  prestige: ['print_8x10', 'print_5x7', 'print_4x6', 'wallet'],
  numerique: [],
};
const PRINTS = ['print_8x10', 'print_5x7', 'print_4x6', 'wallet'];
const off = (n) => Math.round(n * 0.8);

function priceOrder(country, items, prices) {
  for (const { item, qty } of items) {
    if (!Object.hasOwn(prices, item) || !Number.isInteger(qty) || qty < 1) throw new Error('bad item: ' + item);
  }
  // Expand packages into single units, highest price first: first is full, the rest 20% off.
  const units = [];
  for (const { item, qty } of items) if (Object.hasOwn(PACKAGES, item)) for (let i = 0; i < qty; i++) units.push(item);
  units.sort((a, b) => prices[b] - prices[a]);
  const included = new Set(units.flatMap((u) => PACKAGES[u]));
  const lines = [];
  units.forEach((u, i) => lines.push({ item: u, qty: 1, unit: prices[u], discounted: i > 0, amount: i > 0 ? off(prices[u]) : prices[u] }));
  for (const { item, qty } of items) {
    if (Object.hasOwn(PACKAGES, item)) continue;
    const d = PRINTS.includes(item) && included.has(item);
    const unit = prices[item];
    lines.push({ item, qty, unit, discounted: d, amount: (d ? off(unit) : unit) * qty });
  }
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}
module.exports = { priceOrder, PACKAGES };
