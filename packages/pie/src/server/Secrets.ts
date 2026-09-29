import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'

const SECRET_BYTE_LENGTH = 32

export const generateSecret = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const secretBytes = yield* crypto.randomBytes(SECRET_BYTE_LENGTH)

  return Encoding.encodeBase64Url(secretBytes)
})

export const hashSecret = Effect.fn('hashSecret')(function* (secret: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(secret))

  return Encoding.encodeHex(digest)
})
