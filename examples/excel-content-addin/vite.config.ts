import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { assistantApiIntegration } from '../assistant/vite-plugin';
import { yFinanceJapanApiIntegration } from '../workstation/yfinance-jp/vite-plugin';

const EXCEL_ADDIN_ROOT = fileURLToPath(new URL('.', import.meta.url));
const ADDIN_CONFIG = JSON.parse(
  readFileSync(join(EXCEL_ADDIN_ROOT, 'addin.config.json'), 'utf8'),
) as {
  development: {
    host: string;
    port: number;
    certificate: { directory: string; certFile: string; keyFile: string };
  };
};
const CERT_DIR = resolve(homedir(), ADDIN_CONFIG.development.certificate.directory);
const CERT_PATH = join(CERT_DIR, ADDIN_CONFIG.development.certificate.certFile);
const KEY_PATH = join(CERT_DIR, ADDIN_CONFIG.development.certificate.keyFile);

export default defineConfig(({ command }) => {
  const https = command === 'serve'
    ? loadOfficeDevCertificate()
    : undefined;

  return {
    root: EXCEL_ADDIN_ROOT,
    plugins: [assistantApiIntegration(), yFinanceJapanApiIntegration()],
    server: {
      host: ADDIN_CONFIG.development.host,
      port: ADDIN_CONFIG.development.port,
      strictPort: true,
      https,
    },
    build: {
      outDir: '../../dist/excel-content-addin',
      emptyOutDir: true,
    },
  };
});

function loadOfficeDevCertificate(): { cert: Buffer; key: Buffer } {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    throw new Error(
      `Missing trusted Office development certificate in ${CERT_DIR}. `
      + 'Run: npx office-addin-dev-certs install',
    );
  }
  return {
    cert: readFileSync(CERT_PATH),
    key: readFileSync(KEY_PATH),
  };
}
