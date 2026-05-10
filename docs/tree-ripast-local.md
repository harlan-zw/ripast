# ripast declaration tree: local

Command:

```bash
cd harlan-claude-code/skills/ripast/bin
node --experimental-strip-types --no-warnings ./cli.ts tree --exports local --glob '*.ts,!test/**'
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
  declarations
    local  const      globArg  L15:7
    local  const      applyArg  L16:7
    local  const      verifyArg  L17:7
    local  const      vueArg  L18:7
    local  const      jsonArg  L19:7
    local  const      scanCmd  L21:7
    local  const      renameCmd  L49:7
    local  const      treeCmd  L76:7
    local  const      moveCmd  L97:7
    local  interface  MutatingResult  L119:1
    local  function   emitResult  L125:1
    local  const      renameFileCmd  L165:7
    local  const      cssClassRenameCmd  L229:7
    local  function   buildRenameMap  L248:1
    local  const      cssClassScanCmd  L293:7

css-class-rename.ts
  imports
    ./util.ts
    node:fs
    node:process
    oxc-walker
  declarations
    local  const      DEFAULT_SPLIT_RE  L20:7
    local  const      CSS_EXTS  L22:7
    local  const      CODE_EXTS  L23:7
    local  function   safeRead  L53:1
    local  function   mapIncludesAny  L62:1
    local  function   rewriteScript  L70:1
    local  function   rewriteStringsInProgram  L77:1
    local  function   applyEdits  L104:1
    local  function   rewriteVue  L118:1
    local  function   rewriteScriptWithin  L128:1
    local  const      TEMPLATE_BLOCK_RE  L135:7
    local  const      CLASS_ATTR_RE  L136:7
    local  const      NESTED_STRING_RE  L137:7
    local  function   rewriteVueTemplateClassAttrs  L139:1
    local  function   rewriteDynamicClassExpr  L155:1
    local  const      STYLE_BLOCK_RE  L163:7
    local  function   rewriteVueStyleBlocks  L165:1
    local  const      APPLY_RE  L173:7
    local  function   rewriteCss  L175:1

css-class-scan.ts
  imports
    ./util.ts
    node:fs
    node:process
    oxc-walker
  declarations
    local  const      DEFAULT_SPLIT_RE  L18:7
    local  const      CSS_EXTS  L19:7
    local  const      CODE_EXTS  L20:7
    local  function   safeRead  L61:1
    local  function   compileGlobs  L70:1
    local  const      RE_META_RE  L82:7
    local  function   escapeRe  L84:1
    local  const      NUMERIC_RE  L88:7
    local  const      TOKEN_SHAPE_RE  L89:7
    local  function   collectScript  L91:1
    local  function   visitProgramStrings  L100:1
    local  function   collectVue  L111:1
    local  const      TEMPLATE_BLOCK_RE  L119:7
    local  const      CLASS_ATTR_RE  L120:7
    local  const      NESTED_STRING_RE  L121:7
    local  const      STYLE_BLOCK_RE  L122:7
    local  const      APPLY_RE  L123:7
    local  function   visitVueTemplateClassAttrs  L125:1
    local  function   visitVueStyleBlocks  L142:1
    local  function   collectCss  L146:1
    local  function   tokenizeAndEmit  L150:1
    local  function   bareToken  L162:1

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
    local  const      MOVABLE_KINDS  L24:7
    local  function   findNamedExport  L133:1
    local  function   getDeclarationFullText  L160:1
    local  function   countReferencesOutside  L168:1
    local  interface  CollectedImport  L188:1
    local  function   collectUsedImports  L195:1
    local  function   addOrMergeImport  L224:1
    local  function   pruneUnusedImports  L246:1
    local  function   rewriteImportSites  L274:1
    local  const      MODULE_EXT_RE  L304:7
    local  const      WIN_SEP_RE  L305:7
    local  function   computeSpecifier  L307:1
    local  function   splitMultiDeclaratorIfNeeded  L317:1
    local  interface  LocalSiblingDeps  L342:1
    local  function   findLocalSiblingDeps  L347:1
    local  function   findTsconfig  L413:1

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
    local  function   findTsconfig  L60:1

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
    local  const      DECLARATION_KINDS  L28:7
    local  function   findDeclarations  L116:1
    local  function   isDeclarationNameOf  L138:1
    local  const      NESTED_SCOPE_KINDS  L149:7
    local  function   isTopLevelDeclaration  L160:1
    local  function   findTsconfig  L176:1

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
    local  function   scanTemplate  L182:1
    local  function   pushHit  L224:1
    local  function   classify  L238:1
    local  function   importSpecifiers  L334:1
    local  function   moduleSpecifiers  L353:1
    local  function   collectTopLevelDeclarations  L369:1
    local  function   namedExportSpecifiers  L389:1
    local  function   declarationItems  L403:1
    local  function   defaultDeclarationItems  L431:1
    local  function   singleDeclaration  L442:1
    local  function   bindingName  L456:1
    local  const      RESOLVE_EXTS  L468:7
    local  function   resolveModuleSpecifier  L470:1
    local  function   formatMermaidGraph  L487:1
    local  function   formatDotGraph  L499:1
    local  function   summarizeKinds  L511:1
    local  function   nodeIds  L520:1
    local  function   escapeMermaid  L526:1
    local  function   escapeDot  L530:1

util.ts
  imports
    diff
    node:child_process
    node:fs
    node:path
    node:process
    oxc-parser
  declarations
    local  const      EXTS  L26:7
    local  const      SFC_SCRIPT_RE  L50:7
    local  const      SFC_SRC_ATTR_RE  L51:7
    local  function   extractScript  L53:1
    local  function   diffLineCounts  L140:1

verify.ts
  imports
    node:path
    ts-morph
  declarations
    local  function   diagnosticKey  L51:1
    local  function   flattenMessage  L57:1

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
    local  function   listVueFilesContaining  L76:1
    local  function   safeReadFile  L81:1
    local  function   relPath  L90:1
    local  function   collectDiagKeys  L156:1
    local  function   getDiags  L161:1
    local  function   diagKey  L166:1
    local  function   listVueFiles  L170:1

vue-template.ts
  imports
    @vue/compiler-sfc
    oxc-parser
    oxc-walker
  declarations
    local  const      NODE_INTERPOLATION  L10:7
    local  const      NODE_DIRECTIVE  L11:7
    local  const      NODE_ELEMENT  L12:7
    local  const      NODE_SIMPLE_EXPRESSION  L13:7
    local  const      NODE_COMPOUND_EXPRESSION  L14:7
    local  function   hyphenate  L16:1
    local  interface  Edit  L20:1
    local  function   visit  L199:1

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
    local  function   relPath  L190:1

12 files
```
