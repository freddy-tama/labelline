import { defineConfig, loadEnv } from 'vite';
import { devApi } from './server/devApi.ts';

export default defineConfig(({ mode }) => {
  // Prefix '' loads every key in .env for the dev API handlers (server-side only).
  // The browser bundle still only sees VITE_* variables, so GEMINI_API_KEY never ships to it.
  const serverEnv = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [devApi({ env: serverEnv })],
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  };
});
