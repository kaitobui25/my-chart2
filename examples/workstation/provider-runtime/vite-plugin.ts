import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

interface CommandSpec {
  command: string;
  prefixArgs: string[];
  label: string;
}

type JsonRecord = Record<string, any>;

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const packageJson = path.join(current, 'package.json');
    const fiinQuantSidecar = path.join(current, 'examples', 'sidecars', 'fiinquant', 'fiinquant_sidecar.py');
    if (existsSync(packageJson) && existsSync(fiinQuantSidecar)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());
const FIINQUANT_DIR = path.join(REPO_ROOT, 'examples', 'sidecars', 'fiinquant');
const FIINQUANT_ENV_PATH = path.join(FIINQUANT_DIR, '.env');
const FIINQUANT_SIDECAR_PATH = path.join(FIINQUANT_DIR, 'fiinquant_sidecar.py');
const FIINQUANT_REQUIREMENTS_PATH = path.join(FIINQUANT_DIR, 'requirements.txt');
const FIINQUANT_PROVIDER_REQUIREMENTS_PATH = path.join(FIINQUANT_DIR, 'requirements-provider.txt');
const FIINQUANT_VENV_DIR = path.join(FIINQUANT_DIR, '.venv');

function pinnedRequirementVersion(filePath: string, packageName: string): string {
  const requirements = readFileSync(filePath, 'utf8');
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = requirements.match(new RegExp(`^${escapedName}==([^\\s;]+)\\s*$`, 'im'));
  if (!match) throw new Error(`Missing pinned ${packageName} in ${filePath}`);
  return match[1];
}

function providerRequirementVersion(packageName: string): string {
  return pinnedRequirementVersion(FIINQUANT_PROVIDER_REQUIREMENTS_PATH, packageName);
}

const FIINQUANT_REQUIRED_VERSION = providerRequirementVersion('fiinquantx');
const SIGNALRCORE_REQUIRED_VERSION = providerRequirementVersion('signalrcore');
const MSGPACK_REQUIRED_VERSION = pinnedRequirementVersion(FIINQUANT_REQUIREMENTS_PATH, 'msgpack');

export function hasCurrentFiinQuantRuntime(dependencies: unknown): boolean {
  if (!dependencies || typeof dependencies !== 'object') return false;
  const installed = dependencies as Record<string, unknown>;
  return installed.fiinquantx === FIINQUANT_REQUIRED_VERSION
    && installed.signalrcore === SIGNALRCORE_REQUIRED_VERSION
    && installed.msgpack === MSGPACK_REQUIRED_VERSION;
}

function readSimpleEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

const FIINQUANT_ENV = readSimpleEnv(FIINQUANT_ENV_PATH);
const configuredPort = Number(FIINQUANT_ENV.PORT || process.env.FIINQUANT_PORT || 8720);
const FIINQUANT_PORT = Number.isFinite(configuredPort) ? configuredPort : 8720;
const FIINQUANT_TARGET = `http://127.0.0.1:${FIINQUANT_PORT}`;
const FIINQUANT_HEALTH_URL = `${FIINQUANT_TARGET}/health`;
const FIINQUANT_SESSION_URL = `${FIINQUANT_TARGET}/session`;
let fiinQuantChild: ChildProcess | null = null;
let fiinQuantStarting: Promise<JsonRecord> | null = null;

export function fiinQuantProxyToken(): string {
  return String(process.env.FIINQUANT_SIDECAR_TOKEN || FIINQUANT_ENV.SIDECAR_TOKEN || '').trim();
}

function isAllowedBrowserRequest(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function commandSpec(command: string, prefixArgs: string[] = [], label = command): CommandSpec {
  return { command, prefixArgs, label };
}

function runSync(spec: CommandSpec, args: string[], inherit = false) {
  return spawnSync(spec.command, [...spec.prefixArgs, ...args], {
    cwd: FIINQUANT_DIR,
    stdio: inherit ? 'inherit' : 'ignore',
    windowsHide: !inherit,
  });
}

function canRunPython(spec: CommandSpec): boolean {
  const result = runSync(spec, [
    '-c',
    'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)',
  ]);
  return !result.error && result.status === 0;
}

function hasCurrentFiinQuantDependencies(spec: CommandSpec): boolean {
  const versionCheck = [
    'import importlib.metadata as metadata',
    'import aiohttp',
    'import FiinQuantX',
    'import msgpack',
    'from signalrcore.hub_connection_builder import HubConnectionBuilder',
    `ok = metadata.version("fiinquantx") == ${JSON.stringify(FIINQUANT_REQUIRED_VERSION)} and metadata.version("signalrcore") == ${JSON.stringify(SIGNALRCORE_REQUIRED_VERSION)} and metadata.version("msgpack") == ${JSON.stringify(MSGPACK_REQUIRED_VERSION)}`,
    'raise SystemExit(0 if ok else 1)',
  ].join('; ');
  const result = runSync(spec, ['-c', versionCheck]);
  return !result.error && result.status === 0;
}

function fiinQuantVenvPython(): string {
  return process.platform === 'win32'
    ? path.join(FIINQUANT_VENV_DIR, 'Scripts', 'python.exe')
    : path.join(FIINQUANT_VENV_DIR, 'bin', 'python');
}

function bootstrapPythonCandidates(): CommandSpec[] {
  const candidates: CommandSpec[] = [];
  if (process.env.FIINQUANT_PYTHON) {
    candidates.push(commandSpec(process.env.FIINQUANT_PYTHON, [], 'FIINQUANT_PYTHON'));
  }

  if (process.env.VIRTUAL_ENV) {
    const activeVenvPython = process.platform === 'win32'
      ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')
      : path.join(process.env.VIRTUAL_ENV, 'bin', 'python');
    if (existsSync(activeVenvPython)) candidates.push(commandSpec(activeVenvPython, [], 'active virtualenv'));
  }

  if (process.platform === 'win32') {
    candidates.push(commandSpec('py', ['-3.11'], 'Python 3.11 via py launcher'));
    candidates.push(commandSpec('python', [], 'python'));
  } else {
    candidates.push(commandSpec('python3.11', [], 'python3.11'));
    candidates.push(commandSpec('python3', [], 'python3'));
    candidates.push(commandSpec('python', [], 'python'));
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify([candidate.command, candidate.prefixArgs]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runChecked(spec: CommandSpec, args: string[]): void {
  const result = runSync(spec, args, true);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${spec.label} exited with code ${result.status ?? 'unknown'}`);
  }
}

function installFiinQuantEnvironment(venv: CommandSpec): void {
  runChecked(venv, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '-r', FIINQUANT_REQUIREMENTS_PATH,
  ]);
  runChecked(venv, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '-r', FIINQUANT_PROVIDER_REQUIREMENTS_PATH,
  ]);
  // signalrcore 0.9.71 pins msgpack 1.0.2, which is affected by
  // PYSEC-2026-3625. FiinQuant uses SignalR JSON here, so restore the patched
  // msgpack after the provider resolver has installed the rest of its stack.
  runChecked(venv, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '--no-deps', `msgpack==${MSGPACK_REQUIRED_VERSION}`,
  ]);
  if (!hasCurrentFiinQuantDependencies(venv)) {
    throw new Error(
      `FiinQuant .venv does not match FiinQuantX ${FIINQUANT_REQUIRED_VERSION} / signalrcore ${SIGNALRCORE_REQUIRED_VERSION} / msgpack ${MSGPACK_REQUIRED_VERSION} after install.`,
    );
  }
}

function resolveFiinQuantPython(): CommandSpec {
  if (process.env.FIINQUANT_PYTHON) {
    const explicit = commandSpec(process.env.FIINQUANT_PYTHON, [], 'FIINQUANT_PYTHON');
    if (canRunPython(explicit) && hasCurrentFiinQuantDependencies(explicit)) {
      console.log(`[fiinquant] Using FIINQUANT_PYTHON (FiinQuantX ${FIINQUANT_REQUIRED_VERSION})`);
      return explicit;
    }
    console.warn(
      `[fiinquant] FIINQUANT_PYTHON is not on FiinQuantX ${FIINQUANT_REQUIRED_VERSION} / signalrcore ${SIGNALRCORE_REQUIRED_VERSION} / msgpack ${MSGPACK_REQUIRED_VERSION}; using the managed .venv instead.`,
    );
  }

  const venvPython = fiinQuantVenvPython();
  if (existsSync(venvPython)) {
    const existing = commandSpec(venvPython, [], 'FiinQuant .venv');
    if (canRunPython(existing) && hasCurrentFiinQuantDependencies(existing)) {
      console.log(`[fiinquant] Using FiinQuant .venv (FiinQuantX ${FIINQUANT_REQUIRED_VERSION})`);
      return existing;
    }
    if (canRunPython(existing)) {
      console.log(`[fiinquant] Updating local Python environment to FiinQuantX ${FIINQUANT_REQUIRED_VERSION}...`);
      installFiinQuantEnvironment(existing);
      return existing;
    }
    console.warn('[fiinquant] Recreating unusable local Python environment...');
    rmSync(FIINQUANT_VENV_DIR, { recursive: true, force: true });
  }

  console.log(`[fiinquant] Preparing local Python environment with FiinQuantX ${FIINQUANT_REQUIRED_VERSION}...`);
  const bootstrap = bootstrapPythonCandidates().find(canRunPython);
  if (!bootstrap) {
    throw new Error('Python 3.11+ was not found. Install Python 3.11 and run npm run dev again.');
  }

  runChecked(bootstrap, ['-m', 'venv', FIINQUANT_VENV_DIR]);
  const venv = commandSpec(fiinQuantVenvPython(), [], 'FiinQuant .venv');
  installFiinQuantEnvironment(venv);
  return venv;
}

function fiinQuantAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = fiinQuantProxyToken();
  return {
    ...extra,
    ...(token ? { 'X-L2Chart-Sidecar-Token': token } : {}),
  };
}

async function readJson(url: string, options: RequestInit = {}, timeoutMs = 1000): Promise<JsonRecord | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      ...options,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload as JsonRecord : null;
  } catch {
    return null;
  }
}

async function readFiinQuantHealth(): Promise<JsonRecord | null> {
  return readJson(FIINQUANT_HEALTH_URL, { headers: fiinQuantAuthHeaders() });
}

async function waitForFiinQuantHealth(attempts = 80): Promise<JsonRecord | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await readFiinQuantHealth();
    if (health?.ok === true) return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function startFiinQuantSidecar(): void {
  if (fiinQuantChild) return;
  if (!existsSync(FIINQUANT_SIDECAR_PATH)) {
    throw new Error(`Missing FiinQuant sidecar: ${FIINQUANT_SIDECAR_PATH}`);
  }

  const python = resolveFiinQuantPython();
  console.log(`[fiinquant] Starting lazily on port ${FIINQUANT_PORT}...`);
  fiinQuantChild = spawn(python.command, [...python.prefixArgs, FIINQUANT_SIDECAR_PATH], {
    cwd: FIINQUANT_DIR,
    stdio: 'inherit',
    windowsHide: false,
    env: { ...process.env, PORT: String(FIINQUANT_PORT) },
  });
  const child = fiinQuantChild;
  child.once('exit', (code, signal) => {
    if (fiinQuantChild === child) fiinQuantChild = null;
    if (code !== 0 && signal == null) {
      console.warn(`[fiinquant] sidecar exited with code ${code ?? 'unknown'}`);
    }
  });
  child.once('error', (error) => {
    console.warn(`[fiinquant] ${error.message}`);
    if (fiinQuantChild === child) fiinQuantChild = null;
  });
}

async function autoLoginFiinQuant(health: JsonRecord): Promise<JsonRecord> {
  const username = String(FIINQUANT_ENV.FIINQUANT_USERNAME || '').trim();
  const password = String(FIINQUANT_ENV.FIINQUANT_PASSWORD || '');
  if (!username || !password || health.loggedIn === true) return health;

  const token = fiinQuantProxyToken();
  if (!token) {
    throw new Error('SIDECAR_TOKEN is required in examples/sidecars/fiinquant/.env for server-side FiinQuant login.');
  }

  console.log('[fiinquant] Signing in from sidecar .env...');
  const response = await fetch(FIINQUANT_SESSION_URL, {
    method: 'POST',
    headers: fiinQuantAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30_000),
  });
  let payload: JsonRecord | null = null;
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object') payload = parsed as JsonRecord;
  } catch {
    // HTTP status remains the useful failure signal.
  }
  if (!response.ok) {
    throw new Error(`FiinQuant login failed (${response.status}): ${String(payload?.message || response.statusText)}`);
  }

  const nextHealth = await readFiinQuantHealth();
  if (!nextHealth?.loggedIn) {
    throw new Error('FiinQuant accepted login but no logged-in session is reported.');
  }
  console.log('[fiinquant] Lazy connection ready.');
  return nextHealth;
}

async function ensureFiinQuantReady(): Promise<JsonRecord> {
  if (!fiinQuantStarting) {
    fiinQuantStarting = (async () => {
      let health = await readFiinQuantHealth();
      if (!health?.ok) {
        startFiinQuantSidecar();
        health = await waitForFiinQuantHealth();
      }
      if (!health?.ok) {
        throw new Error(`FiinQuant sidecar did not become ready at ${FIINQUANT_HEALTH_URL}`);
      }
      if (!hasCurrentFiinQuantRuntime(health.dependencies)) {
        throw new Error(
          `Running FiinQuant sidecar is not on FiinQuantX ${FIINQUANT_REQUIRED_VERSION} / signalrcore ${SIGNALRCORE_REQUIRED_VERSION} / msgpack ${MSGPACK_REQUIRED_VERSION}. Stop the old sidecar once and try Use again.`,
        );
      }
      const token = fiinQuantProxyToken();
      if (token && health.tokenConfigured === true && health.authorized === false) {
        throw new Error('Running FiinQuant sidecar uses a different SIDECAR_TOKEN. Stop the old sidecar once and try Use again.');
      }
      return autoLoginFiinQuant(health);
    })().finally(() => {
      fiinQuantStarting = null;
    });
  }
  return fiinQuantStarting;
}

function installProviderRuntimeRoutes(middlewares: {
  use(route: string, handler: (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => void | Promise<void>): void;
}): void {
  middlewares.use('/fiinquant-api', async (_req, res, next) => {
    const startup = fiinQuantStarting;
    if (!startup) {
      next();
      return;
    }
    try {
      await startup;
      next();
    } catch (error) {
      sendJson(res, 503, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  middlewares.use('/provider-runtime/health', (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { ok: false, message: 'Cross-site requests are not allowed' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, message: 'Method not allowed' });
      return;
    }
    sendJson(res, 200, { ok: true, version: 1, lazyProviders: ['fiinquant', 'vnstock'] });
  });

  middlewares.use('/provider-runtime/fiinquant/ensure', async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { ok: false, message: 'Cross-site requests are not allowed' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'Method not allowed' });
      return;
    }
    try {
      const health = await ensureFiinQuantReady();
      sendJson(res, 200, { ok: true, health });
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function stopFiinQuantChild(): void {
  const child = fiinQuantChild;
  fiinQuantChild = null;
  if (child && !child.killed) child.kill();
}

export function providerRuntimeIntegration(): Plugin {
  return {
    name: 'l2chart-provider-runtime',
    configureServer(server) {
      installProviderRuntimeRoutes(server.middlewares);
      server.httpServer?.once('close', stopFiinQuantChild);
    },
    configurePreviewServer(server) {
      installProviderRuntimeRoutes(server.middlewares);
      server.httpServer?.once('close', stopFiinQuantChild);
    },
  };
}
