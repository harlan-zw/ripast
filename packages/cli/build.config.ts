import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/cli.ts', './src/presentation/index.ts'],
      rolldown: { external: ['ripide-vue'] },
    },
  ],
})
