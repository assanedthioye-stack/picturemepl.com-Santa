// Test helper: starts the app with one staff member per role whose personal PIN is the role's entry in `pins`.
const { createServer } = require('../server/app');
const staff = require('../server/staff');

const SECRET = 'test-secret';
const NAMES = { host: 'Fatou', photographer: 'Awa', cashier: 'Amy' };
function serve(opts) {
  for (const role of Object.keys(NAMES)) {
    if (opts.pins[role] && !staff.find(opts.db, SECRET, opts.pins[role])) staff.create(opts.db, SECRET, { name: NAMES[role], role, pin: opts.pins[role] });
  }
  return createServer({ secret: SECRET, ...opts });
}
module.exports = { serve, SECRET, NAMES };
