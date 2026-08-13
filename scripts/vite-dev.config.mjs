import { mergeConfig } from 'vite'

import workstationConfig from '../examples/workstation/vite.config.ts'
import { devTerminalTracePlugin } from './dev-trace-vite.mjs'

export default async configEnv => {
  const base = typeof workstationConfig === 'function'
    ? await workstationConfig(configEnv)
    : workstationConfig

  return mergeConfig(base, {
    plugins: [devTerminalTracePlugin()],
  })
}
