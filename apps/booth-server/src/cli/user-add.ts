/**
 * Bootstrap staff accounts until the Admin screens and cloud sync land.
 *   pnpm --filter @pmp/booth-server user:add --name "Awa Diop" --role cashier --secret 4821
 */
import { parseArgs } from 'node:util';
import { schema, writeSynced } from '@pmp/db';
import { STAFF_ROLES, validateSecret, type StaffRole } from '@pmp/shared';
import { hashSecret } from '../auth/auth';
import { openBoothDb } from '../boot';
import { loadConfig } from '../config';
import { uuidv7 } from '../ids';

const { values } = parseArgs({ options: { name: { type: 'string' }, role: { type: 'string' }, secret: { type: 'string' }, locale: { type: 'string' } } });
const role = values.role as StaffRole;
if (!values.name || !STAFF_ROLES.includes(role) || !values.secret) {
  console.error(`usage: user:add --name <full name> --role <${STAFF_ROLES.join('|')}> --secret <PIN or admin password>`);
  process.exit(1);
}
const problem = validateSecret(role, values.secret);
if (problem) { console.error(problem); process.exit(1); }

const db = openBoothDb(loadConfig({ ...process.env, PMP_KIOSK_TOKEN: 'x'.repeat(32) }));
const user = writeSynced(db, schema.users, {
  id: uuidv7(), fullName: values.name, role, pinHash: await hashSecret(values.secret),
  locale: values.locale === 'en' ? 'en' : 'fr',
});
console.log(`created ${user.role} ${user.fullName} (${user.id})`);
