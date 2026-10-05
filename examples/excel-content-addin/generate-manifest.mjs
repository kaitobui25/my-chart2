import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'addin.config.json'), 'utf8'));
const template = readFileSync(join(root, 'manifest.template.xml'), 'utf8');
const args = process.argv.slice(2);
const configuredDevOrigin = `https://${config.development.host}:${config.development.port}`;
const origin = optionValue('--origin') ?? configuredDevOrigin;
const outputArg = optionValue('--output');
const outputPath = outputArg
  ? isAbsolute(outputArg) ? outputArg : resolve(process.cwd(), outputArg)
  : join(root, 'manifest.xml');

assertHttpsOrigin(origin);

const manifest = template
  .replaceAll('{{ORIGIN}}', origin.replace(/\/$/, ''))
  .replaceAll('{{REQUESTED_WIDTH}}', String(config.content.requestedWidth))
  .replaceAll('{{REQUESTED_HEIGHT}}', String(config.content.requestedHeight));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, manifest);

function optionValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

function assertHttpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Manifest origin must be an HTTPS origin without a path: ${value}`);
  }
}
