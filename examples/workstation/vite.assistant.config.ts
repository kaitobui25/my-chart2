import { defineConfig, mergeConfig, type ConfigEnv, type Plugin, type ProxyOptions, type UserConfig } from 'vite';
import baseConfig from './vite.config';

const ASSISTANT_TARGET = 'http://127.0.0.1:8788';
const MAIN_MODULE_SUFFIX = '/examples/workstation/main.ts';
const ACTIVE_TILE_MARKER = 'let activeTile: Tile | null = null;';

function assistantProxy(): Record<string, ProxyOptions> {
  return {
    '/assistant-api': {
      target: ASSISTANT_TARGET,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/assistant-api/, ''),
    },
  };
}

function assistantIntegration(): Plugin {
  return {
    name: 'l2chart-assistant-integration',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/');
      if (!normalizedId.endsWith(MAIN_MODULE_SUFFIX)) return null;
      if (!code.includes(ACTIVE_TILE_MARKER)) {
        throw new Error('L2Chart assistant integration marker is missing. Update vite.assistant.config.ts for the new workstation structure.');
      }

      const bridge = `
window.__L2CHART_ASSISTANT__ = Object.freeze({
  getContext() {
    const tile = activeTile;
    if (!tile) return null;
    const candles = tile.chart.getCandles().slice(-240).map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      ...(candle.volume === undefined ? {} : { volume: candle.volume }),
    }));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      symbol: tile.symbol,
      timeframe: tile.interval,
      mode: tile.mode,
      replay: tile.getReplayInfo(),
      historyRange: tile.getHistoryRange(),
      candleCount: candles.length,
      candles,
      indicators: [...tile.active.keys()].map((id) => ({ id, params: tile.getParams(id) })),
    };
  },
});
`;
      return { code: `${code}\n${bridge}`, map: null };
    },
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module', src: '/assistant/index.ts' },
        injectTo: 'body',
      }];
    },
  };
}

async function resolveBaseConfig(env: ConfigEnv): Promise<UserConfig> {
  if (typeof baseConfig === 'function') return await baseConfig(env);
  return await Promise.resolve(baseConfig);
}

export default defineConfig(async (env: ConfigEnv) => mergeConfig(
  await resolveBaseConfig(env),
  {
    plugins: [assistantIntegration()],
    server: { proxy: assistantProxy() },
    preview: { proxy: assistantProxy() },
  },
));
