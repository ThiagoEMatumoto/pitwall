// Ad-hoc design_* calls against the app launched by design-breads-do-breno.ts
// while it is paused (DS_REAL_PAUSE=1). The scenario writes the session file;
// this reads it and prints the tool result, saving image blocks to --png.
//
//   npx tsx e2e/scenarios/design-breads-do-breno/tool-cli.ts design_tree_summary '{"artboardId":"..."}'
//   npx tsx e2e/scenarios/design-breads-do-breno/tool-cli.ts design_screenshot '{"artboardId":"..."}' --png /tmp/x.png
import { readFileSync, writeFileSync } from 'node:fs'
import { connectMcp } from '../../driver/mcp'
import { SESSION_FILE } from './session'

const [tool, rawArgs = '{}', ...rest] = process.argv.slice(2)
if (!tool) {
  console.error('usage: tool-cli.ts <tool> [jsonArgs] [--png file]')
  process.exit(2)
}
const pngIdx = rest.indexOf('--png')
const pngOut = pngIdx >= 0 ? rest[pngIdx + 1] : undefined

const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as {
  userDataCopy: string
}
const mcp = await connectMcp(session.userDataCopy)
const result = await mcp.callRaw(tool, JSON.parse(rawArgs))

for (const block of result.content ?? []) {
  if (block.type === 'image' && block.data && pngOut) {
    writeFileSync(pngOut, Buffer.from(block.data, 'base64'))
    console.log(`png → ${pngOut}`)
  } else if (block.type === 'text' && block.text) {
    try {
      const parsed = JSON.parse(block.text)
      // Tree summaries read better unescaped.
      if (typeof parsed.text === 'string') {
        const { text, ...meta } = parsed
        console.log(JSON.stringify(meta))
        console.log(text)
      } else console.log(JSON.stringify(parsed, null, 2))
    } catch {
      console.log(block.text)
    }
  }
}
