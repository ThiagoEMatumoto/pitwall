import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build/icon.svg'))

const sizes = [16, 24, 32, 48, 64, 128, 256, 512]

function render(size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng()
}

mkdirSync(join(root, 'build/icons'), { recursive: true })

for (const size of sizes) {
  const png = render(size)
  writeFileSync(join(root, `build/icons/${size}x${size}.png`), png)
  console.log(`build/icons/${size}x${size}.png`)
}

writeFileSync(join(root, 'build/icon.png'), render(512))
console.log('build/icon.png')
