import * as Command from 'effect/unstable/cli/Command'
import { pod } from './commands/Up.ts'

export const pie = Command.make('pie').pipe(Command.withSubcommands([pod]))
