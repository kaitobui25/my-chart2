import json
from pathlib import Path

launcher = Path('scripts/run-assistant.mjs')
text = launcher.read_text(encoding='utf-8')

marker = "const DEFAULT_WORKSTATION_PORT = 53173\n"
replacement = (
    "const DEFAULT_WORKSTATION_PORT = 53173\n"
    "const fiinQuantAutostart = process.argv.includes('--fiinquant')\n"
    "  || /^(1|true|yes)$/i.test(process.env.FIINQUANT_AUTOSTART ?? '')\n"
)
if marker not in text:
    raise SystemExit('launcher constant marker not found')
text = text.replace(marker, replacement, 1)

old = '''  try {
    let fiinQuantHealth = await ensureFiinQuantSidecar()
    fiinQuantHealth = await autoLoginFiinQuant(fiinQuantHealth)
    if (!fiinQuantEnv.SIDECAR_TOKEN) {
      console.warn('[fiinquant] SIDECAR_TOKEN is missing from examples/sidecars/fiinquant/.env.')
    }
  } catch (error) {
    console.warn(`[fiinquant] Optional provider unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  await startOrReuseWorkstation()
'''
new = '''  if (fiinQuantAutostart) {
    try {
      let fiinQuantHealth = await ensureFiinQuantSidecar()
      fiinQuantHealth = await autoLoginFiinQuant(fiinQuantHealth)
      if (!fiinQuantEnv.SIDECAR_TOKEN) {
        console.warn('[fiinquant] SIDECAR_TOKEN is missing from examples/sidecars/fiinquant/.env.')
      }
    } catch (error) {
      console.warn(`[fiinquant] Optional provider unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    console.log('[fiinquant] Autostart disabled. Use "npm run dev:fiinquant" when FiinQuant is needed.')
  }

  await startOrReuseWorkstation()
'''
if old not in text:
    raise SystemExit('launcher startup block marker not found')
launcher.write_text(text.replace(old, new, 1), encoding='utf-8')

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
scripts = package.setdefault('scripts', {})
rebuilt = {}
for key, value in scripts.items():
    rebuilt[key] = value
    if key == 'dev':
        rebuilt['dev:fiinquant'] = 'node scripts/run-assistant.mjs --fiinquant'
package['scripts'] = rebuilt
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
