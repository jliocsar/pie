import * as Command from 'effect/unstable/cli/Command'
import { check } from './commands/Check.ts'
import { pod } from './commands/Pod.ts'
import { routine } from './commands/Routine.ts'
import { sync } from './commands/Sync.ts'

export const pie = Command.make('pie').pipe(
  Command.withDescription('A recipe manager for exe.dev VMs.'),
  Command.withSubcommands([pod, routine, check, sync]),
)
