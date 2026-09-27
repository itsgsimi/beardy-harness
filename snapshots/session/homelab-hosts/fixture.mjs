/** Fixed Beardy hosts --json response; no Beardy executable or LAN endpoint is called. */
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export const name = 'homelab-subprocess-fixture'

export default class HomelabSubprocessFixture extends SubprocessRuntime {
  async terminalEnvironment() { return { platform: 'posix' } }
  async resolveExecutable(command) { return command }
  async spawnTerminal() { throw new Error('unexpected terminal spawn') }

  spawn(spec) {
    if (!spec.argv[0].endsWith('/beardy/bin/bdy')
      || JSON.stringify(spec.argv.slice(1)) !== JSON.stringify(['--json', '--timeout', '10', 'hosts', 'list', '--no-probe'])) {
      throw new Error('unexpected Beardy argv')
    }
    const text = JSON.stringify([{ id: 'mini', addr: '192.168.1.123', user: 'goran', ssh: '-', role: 'mini PC', tags: ['server', 'docker'] }]) + '\n'
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      terminate() {},
      async waitForExit() { return true },
    }
  }
}
