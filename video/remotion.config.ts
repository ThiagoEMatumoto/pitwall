import {Config} from '@remotion/cli/config'

// Resolucao e fps sao propriedades da composicao (ver src/config.ts); o
// remotion.config.ts so cobre o que e do renderer.
Config.setCodec('h264')
Config.setOverwriteOutput(true)
Config.setVideoImageFormat('jpeg')
