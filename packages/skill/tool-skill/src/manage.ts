/**
 * Model-facing creation, replacement, and removal of workspace-local flat
 * skills. The filesystem service owns mutation and sandbox semantics; this
 * module owns the skill document format and target restriction.
 * @module @deepseek-ai/dsh-tool-skill/manage
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

type ManageAction = 'create' | 'update' | 'delete'

interface ManageArgs {
  action: ManageAction
  name: string
  description?: string
  content?: string
  when_to_use?: string
  model_invocable?: boolean
  user_invocable?: boolean
}

interface ManageResult {
  action: ManageAction
  name: string
  path: string
  status: 'created' | 'updated' | 'deleted'
}

/** Register the workspace skill-management tool over the supplied filesystem. */
export function applySkillManageTool(ctx: Context, fs: FileSystem): void {
  ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: 'Create, update, or delete a workspace skill. Skills are stored as flat Markdown files under .agents/skills and become available to the skill loader after the catalog refreshes.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update', 'delete'], description: 'Operation to perform.' },
      name: { type: 'string', required: true, description: 'Kebab-case skill name.' },
      description: { type: 'string', description: 'Short description for create or update.' },
      content: { type: 'string', description: 'Markdown instructions for create or update.' },
      when_to_use: { type: 'string', description: 'Optional routing guidance for create or update.' },
      model_invocable: { type: 'boolean', description: 'Whether the model may load the skill; defaults to true.' },
      user_invocable: { type: 'boolean', description: 'Whether a user may invoke the skill with /name; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['create', 'update', 'delete'] },
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['created', 'updated', 'deleted'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.status} skill ${value.name} at ${value.path}` }],
    },
    async execute(args: ManageArgs, exec): Promise<ManageResult> {
      const agent = requireAgent(exec)
      validateName(args.name)
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new Error('skill_manage requires a workspace cwd')
      const rootPath = join(cwd, '.agents', 'skills')
      await fs.makeDirectory(await fs.resolve(rootPath, { signal: exec.signal }), exec.signal)
      const filePath = join(rootPath, `${args.name}.md`)
      const filePathInfo = await fs.lstat(filePath, undefined, exec.signal)
      if (filePathInfo?.type === 'symlink') throw new Error(`skill "${args.name}" is a symbolic link and cannot be managed`)
      const target = await fs.resolve(filePath, { signal: exec.signal })
      const root = await fs.resolve(rootPath, { signal: exec.signal })
      const workspace = await fs.resolve(cwd, { signal: exec.signal })
      if (!fs.contains(workspace, root)) throw new Error('workspace skill directory escaped the workspace')
      if (!fs.contains(root, target)) throw new Error('skill target escaped the workspace skill directory')

      const existing = await fs.stat(target, exec.signal)
      if (args.action === 'delete') {
        if (existing === undefined) throw new Error(`skill "${args.name}" does not exist in the workspace skill directory`)
        if (existing.type !== 'file') throw new Error(`skill "${args.name}" is not a regular file`)
        await fs.removeFile(target, exec.signal)
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        return { action: args.action, name: args.name, path: target.displayPath, status: 'deleted' }
      }

      const content = renderSkillFile(args)
      if (args.action === 'create' && existing !== undefined) {
        throw new Error(`skill "${args.name}" already exists; use update instead`)
      }
      if (args.action === 'update' && existing === undefined) {
        throw new Error(`skill "${args.name}" does not exist; use create instead`)
      }
      if (existing !== undefined && existing.type !== 'file') {
        throw new Error(`skill "${args.name}" is not a regular file`)
      }
      const expected = existing === undefined
        ? { kind: 'createIfAbsent' as const }
        : { kind: 'replaceIfVersion' as const, version: existing.version }
      ctx.emit('fs/observed', target, existing === undefined
        ? { kind: 'absent' }
        : { kind: 'present', version: existing.version }, exec)
      const outcome = await fs.writeText(target, content, expected, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        action: args.action,
        name: args.name,
        path: target.displayPath,
        status: outcome.operation === 'create' ? 'created' : 'updated',
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `${args.action} skill ${args.name}`, kind: args.action === 'delete' ? 'delete' : 'execute', rawInput: args.name }
    },
  }))
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('skill_manage requires an Agent-backed session')
  return exec.agent
}

function validateName(name: string): void {
  if (!isSkillName(name)) throw new Error(`invalid skill name "${name}"`)
}

function renderSkillFile(args: ManageArgs): string {
  const description = args.description?.trim()
  if (description === undefined || description.length === 0) throw new Error('description is required for create and update')
  if (args.content === undefined) throw new Error('content is required for create and update')
  const frontmatter = [
    `name: ${JSON.stringify(args.name)}`,
    `description: ${JSON.stringify(description)}`,
    ...args.when_to_use?.trim() ? [`whenToUse: ${JSON.stringify(args.when_to_use.trim())}`] : [],
    ...(args.model_invocable === false ? ['disable-model-invocation: true'] : []),
    ...(args.user_invocable === false ? ['user-invocable: false'] : []),
  ]
  return `---\n${frontmatter.join('\n')}\n---\n\n${args.content.replace(/\n*$/, '')}\n`
}
