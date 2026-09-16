/** Bounded audio decoding through the harness subprocess provider. */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** Collect bytes while enforcing the complete stream's limit. */
export async function collectBytes(data: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of data) {
    size += chunk.byteLength
    if (size > limit) throw new Error('Audio exceeds the configured limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/** Decode a single audio track to 16 kHz PCM, rejecting recordings over the limit. */
export async function decodeAudio(
  subprocess: SubprocessRuntime, bytes: Uint8Array, executable: string,
  maxSeconds: number, signal: AbortSignal,
): Promise<Buffer> {
  const process = subprocess.spawn({
    argv: [executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0',
      '-vn', '-sn', '-dn', '-t', String(maxSeconds + 1),
      '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    cwd: '.', signal, graceMs: 1000,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
  })
  /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
  if (process.stdin === undefined || process.stdout === undefined) {
    throw new Error('speech-whisper: subprocess implementation dropped a piped decoder stream')
  }
  /* v8 ignore stop */
  const input = pipeline(Readable.from([bytes]), process.stdin)
  const output = collectBytes(process.stdout, maxSeconds * 32000)
  try {
    const [, pcm, outcome] = await Promise.all([input, output, process.done])
    signal.throwIfAborted()
    if (outcome.exitCode !== 0 || pcm.length === 0) throw new Error('The recording could not be decoded')
    const header = Buffer.alloc(44)
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28)
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
  } finally {
    process.terminate()
    await Promise.allSettled([input, output, process.done])
    await process.waitForExit()
  }
}
