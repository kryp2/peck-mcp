import { PrivateKey, Utils, SignedMessage } from '@bsv/sdk'

export interface ChannelState {
  channelId: string;
  revision: number;
  balanceA: number; // Client
  balanceB: number; // Server
  signatureA?: string;
  signatureB?: string;
}

export function signChannelState(state: Omit<ChannelState, 'signatureA'|'signatureB'>, key: PrivateKey): string {
  const msg = JSON.stringify({
    channelId: state.channelId,
    revision: state.revision,
    balanceA: state.balanceA,
    balanceB: state.balanceB
  })
  const sigArray = SignedMessage.sign(Utils.toArray(msg, 'utf8'), key)
  return Utils.toBase64(sigArray)
}

export function verifyChannelState(state: ChannelState, pubkey: string): boolean {
  if (!state.signatureA) return false;
  try {
    const msg = JSON.stringify({
      channelId: state.channelId,
      revision: state.revision,
      balanceA: state.balanceA,
      balanceB: state.balanceB
    })
    const signatureArray = Utils.toArray(state.signatureA, 'base64')
    if (!SignedMessage.verify(Utils.toArray(msg, 'utf8'), signatureArray)) return false
    const reader = new Utils.Reader(signatureArray)
    reader.read(4) // version
    const signerPubkey = Utils.toHex(reader.read(33))
    return signerPubkey === pubkey
  } catch (err) {
    return false
  }
}
