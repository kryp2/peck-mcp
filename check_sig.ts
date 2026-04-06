import { SignedMessage, PrivateKey, Utils, PublicKey } from '@bsv/sdk'
const msg = Utils.toArray('hello', 'utf8')
const pk = PrivateKey.fromRandom()
const sig = SignedMessage.sign(msg, pk)
console.log(SignedMessage.verify(msg, sig, pk.toPublicKey().toAddress().toString()))
