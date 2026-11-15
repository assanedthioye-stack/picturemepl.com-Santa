// Dev-only lint config: run with `npx -y -p eslint@9 -p @eslint/js@9 -p globals eslint .`
const js = require('@eslint/js');
const globals = require('globals');
module.exports = [
  { ignores: ['node_modules/', 'data/', 'public/'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node }, rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }], 'no-control-regex': 'off' } },
  { files: ['test/ui.test.js'], languageOptions: { globals: globals.browser } }, // page.evaluate callbacks run in the browser
];
