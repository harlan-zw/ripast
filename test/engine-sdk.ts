import { createEngine } from 'ripide-api'
import vue from 'ripide-vue'

export * from 'ripide-api'
export { runVueTemplateUnwrap, runVueTemplateWrap } from 'ripide-vue'
const engine = createEngine({ extensions: [vue] })
export const { scan, buildScanGraph, buildDeclarationTree, buildUnusedDeclarations, runRename, runMove, runDelete, runRenameFile, runReplace, runCssClassScan, runCssClassFileScan, runCssClassRename, runDoctor, buildComponentInventory, buildComponentDetail } = engine
