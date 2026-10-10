import ts from '@typescript/typescript6'

export function literalNuxtConfig(source: string): ts.Expression | undefined {
  const file = ts.createSourceFile('nuxt.config.ts', source, ts.ScriptTarget.Latest, true)
  const exported = file.statements.find(ts.isExportAssignment)
  if (!exported)
    return undefined
  const expression = exported.expression
  const variables = new Map<string, ts.Expression>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const))
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        variables.set(declaration.name.text, declaration.initializer)
    }
  }
  const resolve = (value: ts.Expression, seen = new Set<string>()): ts.Expression | undefined => {
    if (!ts.isIdentifier(value) || seen.has(value.text))
      return value
    const initializer = variables.get(value.text)
    if (!initializer)
      return undefined
    seen.add(value.text)
    return resolve(initializer, seen)
  }
  const config = ts.isCallExpression(expression) ? expression.arguments[0] : expression
  return config && resolve(config)
}
export function configProperty(expression: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!expression)
    return undefined
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
    return configProperty(expression.expression, name)
  if (!ts.isObjectLiteralExpression(expression))
    return undefined
  const property = expression.properties.find(property => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name)
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined
}
export function literalString(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : undefined
}
