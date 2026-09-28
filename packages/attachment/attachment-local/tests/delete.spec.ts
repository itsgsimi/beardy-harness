import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  homes.push(path)
  return path
}

async function store(): Promise<{ attachments: LocalAttachmentStore; dshHome: string }> {
  const dshHome = await directory('dsh-attachment-delete-')
  return { attachments: new LocalAttachmentStore(new Context(), { dshHome }), dshHome }
}

async function frame(shade: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width: 64, height: 32, channels: 3, background: { r: shade, g: 60, b: 120 } },
  }).jpeg().toBuffer())
}

function variantDirectory(dshHome: string, ref: ImageAttachmentRef): string {
  const sha256 = String(ref.attachmentId).slice('sha256:'.length)
  return join(dshHome, 'cache', 'attachments', 'request-images', sha256.slice(0, 2), sha256)
}

describe('local image deletion', () => {
  it('removes the object and its cached request versions, and reports an absent object without failing', async () => {
    const { attachments, dshHome } = await store()
    const ref = await attachments.saveImage({ data: await frame(20), mediaType: 'image/jpeg', name: 'front-door-1.jpg' })
    const kept = await attachments.saveImage({ data: await frame(200), mediaType: 'image/jpeg' })
    await attachments.readImageRequest(ref, { width: 16, height: 8, maxBytes: 4_096 })
    await attachments.readImageRequest(ref, { width: 32, height: 16, maxBytes: 4_096 })
    await expect(readdir(variantDirectory(dshHome, ref))).resolves.toHaveLength(2)

    await expect(attachments.deleteImage(ref)).resolves.toBe(true)

    await expect(readFile(attachments.imageHostPath(ref))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(variantDirectory(dshHome, ref))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(attachments.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(attachments.readImageRequest(ref, { width: 16, height: 8, maxBytes: 4_096 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(attachments.readImage(kept)).resolves.toMatchObject({ ref: kept })
    await expect(attachments.deleteImage(ref)).resolves.toBe(false)
  })

  it('treats a store that never saved anything as already empty', async () => {
    const { attachments } = await store()
    const ref = { attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as const
    await expect(attachments.deleteImage(ref)).resolves.toBe(false)
  })

  it('refuses a reference that is not a local content address', async () => {
    const { attachments } = await store()
    for (const attachmentId of ['sha256:../../outside', `SHA256:${'ab'.repeat(32)}`, '']) {
      await expect(attachments.deleteImage({ attachmentId: AttachmentId(attachmentId), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }))
        .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    }
  })

  it('refuses an object whose directory resolves outside the store and leaves the outside file', async () => {
    const { attachments } = await store()
    const ref = await attachments.saveImage({ data: await frame(20), mediaType: 'image/jpeg' })
    const object = attachments.imageHostPath(ref)
    const objects = dirname(dirname(object))
    const outside = await directory('dsh-attachment-outside-')
    await rename(objects, join(outside, 'objects'))
    await symlink(join(outside, 'objects'), objects, 'junction')

    await expect(attachments.deleteImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    await expect(attachments.readImage(ref)).resolves.toMatchObject({ ref })
  })

  it('reports a removal failure as a write failure', async () => {
    const { attachments } = await store()
    const ref = await attachments.saveImage({ data: await frame(20), mediaType: 'image/jpeg' })
    const object = attachments.imageHostPath(ref)
    await chmod(object, 0o600)
    await rm(object)
    await mkdir(object)

    await expect(attachments.deleteImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })

  it.skipIf(process.platform === 'win32')('reports a cache removal failure after removing the object', async () => {
    const { attachments, dshHome } = await store()
    const ref = await attachments.saveImage({ data: await frame(20), mediaType: 'image/jpeg' })
    const shard = dirname(variantDirectory(dshHome, ref))
    await mkdir(dirname(shard), { recursive: true })
    await writeFile(shard, 'not a directory')

    await expect(attachments.deleteImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    await expect(attachments.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })

  it('lets a read racing the removal finish with verified bytes or report the image as gone', async () => {
    const { attachments } = await store()
    const data = await frame(20)
    for (let round = 0; round < 8; round++) {
      const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg' })
      const [read, removed] = await Promise.allSettled([attachments.readImage(ref), attachments.deleteImage(ref)])
      expect(removed).toEqual({ status: 'fulfilled', value: true })
      if (read.status === 'fulfilled') expect(read.value.ref).toEqual(ref)
      else expect(read.reason).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    }
  })
})
