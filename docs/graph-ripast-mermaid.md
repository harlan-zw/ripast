# ripast graph scan: Mermaid

Command:

```bash
cd harlan-claude-code/skills/ripast/bin
node --experimental-strip-types --no-warnings ./cli.ts scan ripast --graph mermaid --glob '*.ts'
```

Output:

```mermaid
flowchart LR
  n0["cli.ts<br/>1 hits: string-literal 1"]
  n1["rename-file.ts<br/>1 hits: string-literal 1"]
  n2["scan.ts<br/>1 hits: string-literal 1"]
  n3["test/atomic.test.ts<br/>2 hits: string-literal 2"]
  n4["test/helpers.ts<br/>2 hits: string-literal 2"]
  n5["test/monorepo.test.ts<br/>1 hits: string-literal 1"]
  n6["test/rename-file.test.ts<br/>1 hits: string-literal 1"]
  n7["test/vue.test.ts<br/>2 hits: string-literal 2"]
  n0 -->|./rename-file.ts| n1
  n0 -->|./scan.ts| n2
  n3 -->|./helpers.ts| n4
  n6 -->|../rename-file.ts| n1
```
