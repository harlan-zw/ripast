import { createEngine } from '@ripast/core'
import vue from '@ripast/vue'

export * from '@ripast/core'
export { runVueTemplateUnwrap, runVueTemplateWrap } from '@ripast/vue'
const engine = createEngine({ extensions: [vue] })
export const { scan, buildScanGraph, buildDeclarationTree, buildUnusedDeclarations, runRename, runMove, runDelete, runRenameFile, runReplace, runCssClassScan, runCssClassFileScan, runCssClassRename, runDoctor, buildComponentInventory, buildComponentDetail } = engine
