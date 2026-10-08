// Simulates the Codex exec JSONL and last-message contract without accessing the network.
import { appendFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
let prompt = ''
for await (const part of process.stdin) prompt += String(part)

const outputIndex = args.indexOf('--output-last-message')
const outputPath = args[outputIndex + 1]
const resumed = args.includes('resume')
const mode = process.env.FAKE_CODEX_MODE
const existing = resumed ? args[args.length - 2] : null
const sessionId = mode === 'mismatch' ? randomUUID() : existing ?? randomUUID()

if (args[0] !== 'exec' || !args.includes('--json') || !args.includes('--skip-git-repo-check')
  || !args.includes('sandbox_mode="read-only"') || !outputPath
  || (resumed && args.includes('--output-schema'))
  || (!resumed && !args.includes('--output-schema'))
  || (resumed && !existing)) {
  process.stderr.write('Incorrect Codex exec invocation')
  process.exit(2)
}
if (process.env.FAKE_CODEX_TRACE) {
  await appendFile(process.env.FAKE_CODEX_TRACE, JSON.stringify({ args, prompt, sessionId }) + '\n')
}

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: sessionId }) + '\n')
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n')
if (mode === 'sleep') {
  await new Promise(resolve => setTimeout(resolve, 30_000))
}
if (mode === 'failed') {
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'fake failure' } }) + '\n')
  process.exit(1)
}
const response = mode === 'bad-response'
  ? 'invalid-json'
  : prompt.includes('request-rsi') && !prompt.includes('Continue the pending')
    ? JSON.stringify({ message: '', requests: [{ tool: 'get_indicator', timeframe: '1d', id: 'rsi', limit: 12, paramsJson: '{}' }] })
    : JSON.stringify({ message: resumed ? 'resumed' : 'started', requests: [] })
await writeFile(outputPath, response)
if (mode !== 'incomplete') process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n')
