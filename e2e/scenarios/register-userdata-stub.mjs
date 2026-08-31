// `--import` so IMPORTA o modulo; quem instala hooks de resolucao e
// module.register(). Este arquivo e o registrador; os hooks vivem no ao lado.
import { register } from 'node:module'
register('./userdata-stub-hooks.mjs', import.meta.url)
