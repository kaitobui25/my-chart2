import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';
import baseConfig from './vite.config';
import { scannerIntegration } from './scanner/vite-plugin';

async function resolveBase(env: ConfigEnv): Promise<UserConfig> {
  if (typeof baseConfig === 'function') {
    return await baseConfig(env);
  }
  return await baseConfig;
}

export default defineConfig(async (env) => {
  const base = await resolveBase(env);
  return {
    ...base,
    plugins: [...(base.plugins ?? []), scannerIntegration()],
  };
});
