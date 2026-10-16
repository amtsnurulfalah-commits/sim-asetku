import {defineConfig,globalIgnores} from 'eslint/config';
import nextPlugin from '@next/eslint-plugin-next';
import hooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
export default defineConfig([
 ...tseslint.configs.recommended,
 {files:['src/**/*.{ts,tsx}','tests/**/*.ts'],plugins:{'@next/next':nextPlugin,'react-hooks':hooks},rules:{...nextPlugin.configs.recommended.rules,...nextPlugin.configs['core-web-vitals'].rules,...hooks.configs.recommended.rules}},
 globalIgnores(['.next/**','node_modules/**','next-env.d.ts'])
]);
