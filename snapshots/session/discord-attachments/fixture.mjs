/** Record the production parser’s attachment references in an ordinary headless turn. */
import {parseMessageCreate} from '../../../packages/discord/discord-gateway/lib/types/gateway.js'
export const name = 'discord-attachment-fixture'
export function apply(ctx) {
  ctx.on('agent/pre-step', async (_event, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return {...decision, messages: decision.messages.map(message => {
      if (message.source?.kind !== 'user') return message
      const parsed = parseMessageCreate({id: 'fixture-message', channel_id: 'fixture-channel',
        author: {id: 'fixture-user'}, content: message.content.map(block => block.text ?? '').join(''),
        attachments: [{filename: 'week-2.png', url: 'https://cdn.discordapp.com/attachments/1/2/week-2.png',
          content_type: 'image/png', size: 12345}]})
      return {...message, content: [{type: 'text', text: parsed.content}]}
    })}
  }, {prepend: true})
}
