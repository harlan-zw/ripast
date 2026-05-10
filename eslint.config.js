import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'no-console': 'off',
    'node/prefer-global/process': 'off',
    'ts/no-use-before-define': 'off',
  },
  ignores: ['dist', 'node_modules', 'test/**/fixtures/**'],
})
