import * as Arr from 'effect/Array'
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Command from 'effect/unstable/cli/Command'
import type { Device } from '../Api.ts'
import { PieClient } from './PieClient.ts'
import { abbreviateCommit } from './Up.ts'

const COLUMN_GAP = '  '

const AGE_UNITS = [
  { suffix: 'd', toUnits: Duration.toDays },
  { suffix: 'h', toUnits: Duration.toHours },
  { suffix: 'm', toUnits: Duration.toMinutes },
]

const describeAge = (age: Duration.Duration) =>
  Arr.findFirst(AGE_UNITS, (unit) => unit.toUnits(age) >= 1).pipe(
    Option.match({
      onNone: () => 'just now',
      onSome: (unit) => `${Math.floor(unit.toUnits(age))}${unit.suffix} ago`,
    }),
  )

const podRowOf = (pod: Device, now: DateTime.Utc) => [
  pod.name,
  Option.getOrElse(pod.recipe, () => '-'),
  pod.lastUpCommit.pipe(
    Option.map(abbreviateCommit),
    Option.getOrElse(() => '-'),
  ),
  Option.getOrElse(pod.invitedBy, () => '-'),
  Option.match(pod.lastSeenAt, {
    onNone: () => 'never',
    onSome: (lastSeenAt) => describeAge(DateTime.distance(lastSeenAt, now)),
  }),
]

const renderTable = (header: readonly string[], rows: readonly (readonly string[])[]) => {
  const columnWidths = Arr.reduce(
    rows,
    Arr.map(header, (heading) => heading.length),
    (widths, row) => Arr.zipWith(widths, row, (width, cell) => Math.max(width, cell.length)),
  )

  return Arr.map([header, ...rows], (row) =>
    Arr.zipWith(row, columnWidths, (cell, width) => cell.padEnd(width))
      .join(COLUMN_GAP)
      .trimEnd(),
  ).join('\n')
}

export const pods = Command.make('pods').pipe(
  Command.withSubcommands([
    Command.make(
      'ls',
      {},
      Effect.fn(function* () {
        const pieClient = yield* PieClient
        const client = yield* pieClient.joined
        const podList = yield* client.pods.list()
        const now = yield* DateTime.now

        if (Arr.isReadonlyArrayNonEmpty(podList)) {
          return yield* Console.log(
            renderTable(
              ['NAME', 'RECIPE', 'COMMIT', 'INVITED BY', 'LAST SEEN'],
              Arr.map(podList, (pod) => podRowOf(pod, now)),
            ),
          )
        }

        return yield* Console.error('No pods yet. Invite one with `pie invite new`.')
      }),
    ).pipe(Command.provide(PieClient.layer)),
  ]),
)
