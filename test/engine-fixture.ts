import { createEngine } from '../packages/core/src/index.ts'
import { createVueExtension } from '../packages/vue/src/index.ts'

export function vueServices() {
  return createEngine({ extensions: [createVueExtension()] }).services
}
