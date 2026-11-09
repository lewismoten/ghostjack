// ESLint flat config: recommended rules; browser globals for web/, node globals elsewhere.
// docs/ is the generated copy of web/ (npm run pages), so it is ignored.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['docs/**', 'node_modules/**', 'captures/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.mjs', 'tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // three.js is imported from a CDN at run time (web/scene.js), not bundled.
    files: ['web/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
];
