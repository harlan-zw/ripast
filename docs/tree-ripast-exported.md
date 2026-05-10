# ripast declaration tree: exported

Command:

```bash
cd harlan-claude-code/skills/ripast/bin
node --experimental-strip-types --no-warnings ./cli.ts tree --exports exported --glob '*.ts,!test/**'
```

Output:

```text
cli.ts
  imports
    ./css-class-rename.ts
    ./css-class-scan.ts
    ./move.ts
    ./rename-file.ts
    ./rename.ts
    ./scan.ts
    ./util.ts
    ./verify.ts
    citty
    node:fs
    node:path
    node:process

css-class-rename.ts
  imports
    ./util.ts
    node:fs
    node:process
    oxc-walker
  declarations
    export interface  CssClassRenameOptions  L7:8
    export interface  CssClassRenameResult  L12:8
    export type       RenameMap  L18:8
    export function   runCssClassRename  L25:8
    export function   rewriteClassString  L179:8
    export function   rewriteToken  L195:8

css-class-scan.ts
  imports
    ./util.ts
    node:fs
    node:process
    oxc-walker
  declarations
    export interface  CssClassScanOptions  L6:8
    export interface  CssClassScanHit  L12:8
    export function   runCssClassScan  L22:8
    export function   formatScanHits  L183:8

move.ts
  imports
    ./util.ts
    ./verify.ts
    ./vue-bridge.ts
    node:fs
    node:path
    node:process
    ts-morph
  declarations
    export interface  MoveOptions  L11:8
    export interface  MoveResult  L18:8
    export function   runMove  L32:8

rename-file.ts
  imports
    ./util.ts
    ./verify.ts
    ./vue-bridge.ts
    ./vue.ts
    node:fs
    node:path
    node:process
    vscode-uri
  declarations
    export interface  RenameFileOptions  L10:8
    export interface  RenameFileResult  L16:8
    export function   runRenameFile  L23:8

rename.ts
  imports
    ./util.ts
    ./verify.ts
    ./vue-bridge.ts
    node:fs
    node:path
    node:process
    ts-morph
  declarations
    export interface  RenameOptions  L12:8
    export interface  RenameResult  L22:8
    export function   runRename  L37:8

scan.ts
  imports
    ./util.ts
    ./vue-template.ts
    node:fs
    node:path
    node:process
    oxc-parser
    oxc-walker
  declarations
    export interface  ScanHit  L9:8
    export interface  ScanOptions  L17:8
    export interface  ScanGraphNode  L23:8
    export interface  ScanGraphEdge  L28:8
    export interface  ScanGraph  L34:8
    export type       ExportFilter  L40:8
    export interface  DeclarationTreeItem  L42:8
    export interface  DeclarationTreeFile  L50:8
    export interface  DeclarationTree  L57:8
    export function   scan  L61:8
    export function   buildScanGraph  L91:8
    export function   buildDeclarationTree  L150:8
    export function   formatHits  L285:8
    export function   formatScanGraph  L301:8
    export function   formatDeclarationTree  L305:8

util.ts
  imports
    diff
    node:child_process
    node:fs
    node:path
    node:process
    oxc-parser
  declarations
    export interface  ParsedFile  L8:8
    export interface  FileChange  L19:8
    export function   rgFiles  L28:8
    export function   parseFile  L71:8
    export function   spliceScript  L89:8
    export function   writeChanges  L95:8
    export function   printDiffs  L116:8
    export interface  ChangeSummary  L123:8
    export function   summarize  L129:8
    export function   posToLineCol  L162:8

verify.ts
  imports
    node:path
    ts-morph
  declarations
    export interface  Regression  L4:8
    export interface  DiagnosticSnapshot  L12:8
    export function   snapshotDiagnostics  L16:8
    export function   findRegressions  L25:8
    export function   formatRegressions  L74:8

vue-bridge.ts
  imports
    ./util.ts
    ./verify.ts
    ./vue-template.ts
    ./vue.ts
    node:child_process
    node:fs
    node:path
    vscode-uri
  declarations
    export function   hasVueFiles  L11:8
    export function   hasVueFilesContaining  L16:8
    export interface  RenameSite  L21:8
    export function   applyVueRename  L27:8
    export function   applyVueImportRewrite  L94:8
    export function   vueRegressions  L112:8

vue-template.ts
  imports
    @vue/compiler-sfc
    oxc-parser
    oxc-walker
  declarations
    export interface  TemplateExpression  L5:8
    export function   rewriteTemplateReferences  L22:8
    export function   extractTemplateExpressions  L182:8

vue.ts
  imports
    ./util.ts
    @volar/language-service
    @volar/typescript
    @vue/language-core
    @vue/language-service
    node:fs
    node:path
    node:process
    typescript
    volar-service-typescript
    vscode-languageserver-protocol
    vscode-languageserver-textdocument
    vscode-uri
  declarations
    export interface  VueService  L17:8
    export function   createVueService  L26:8
    export function   workspaceEditToChanges  L145:8

12 files
```
