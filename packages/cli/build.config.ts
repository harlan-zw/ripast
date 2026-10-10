import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/cli.ts', './src/presentation/index.ts', './src/check.ts', './src/test-runner.ts', './src/test-worker.ts'],
      rolldown: { external: ['ripide-vue'] },
    },
  ],
})
