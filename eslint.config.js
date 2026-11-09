// ESLint flat config: recommended rules; browser globals for web/, node globals elsewhere.
// docs/ is the generated copy of web/ (npm run pages), so it is ignored.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['web/vendor/**', 'docs/**', 'node_modules/**', 'captures/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.mjs', 'tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // three.js is vendored in web/vendor/ (not linted) and imported as a module at run time.
    files: ['web/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
];
