import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqliteMigrator from '@effect/sql-sqlite-bun/SqliteMigrator'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Str from 'effect/String'
import { createDevicesAndInvites } from './migrations/1_create_devices_and_invites.ts'
import { createSettings } from './migrations/2_create_settings.ts'

const DATABASE_FILE_NAME = 'pie.sqlite'

export const databaseLayer = (dataDirectory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* fileSystem.makeDirectory(dataDirectory, { recursive: true })

      return SqliteMigrator.layer({
        loader: SqliteMigrator.fromRecord({
          '1_create_devices_and_invites': createDevicesAndInvites,
          '2_create_settings': createSettings,
        }),
      }).pipe(
        Layer.provideMerge(
          SqliteClient.layer({
            filename: path.join(dataDirectory, DATABASE_FILE_NAME),
            transformResultNames: Str.snakeToCamel,
            transformQueryNames: Str.camelToSnake,
          }),
        ),
      )
    }),
  )
