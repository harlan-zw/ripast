import process from 'node:process'
import { createEngine } from 'ripide-api'
import { checkEnginePlanCapability } from './engine-plan-gate.ts'

checkEnginePlanCapability(createEngine()).then((outcome) => {
  console.log(JSON.stringify(outcome))
  process.exitCode = outcome._tag === 'Passed' ? 0 : outcome._tag === 'Unavailable' ? 4 : 1
})
