export type JsonTag = 'Preview' | 'Applied' | 'Refused' | 'Empty' | 'Result' | 'Error'

/** Outcome appears once. Data never contains competing execution flags. */
export type JsonResult = {
  [Tag in JsonTag]: { _tag: Tag, command: string, base: string, data: unknown }
}[JsonTag]

export function jsonResult(tag: JsonTag, command: string, base: string, data: unknown): JsonResult {
  return { _tag: tag, command, base, data }
}

export function mutationTag(apply: boolean, refused: boolean, changes: number): JsonTag {
  if (refused)
    return 'Refused'
  if (!changes)
    return 'Empty'
  return apply ? 'Applied' : 'Preview'
}
