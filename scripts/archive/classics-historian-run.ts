/**
 * peck.classics historian run — long-form retrospectives, no AI/agent/persona mentions
 * 8 posts chained via UTXO, posted to peck.classics with tags
 * Pattern: klio-post.ts (EF broadcast, OP_FALSE+OP_RETURN, await sign)
 */

import { Transaction, PrivateKey, P2PKH, Script, OP } from '@bsv/sdk'

const SIGNING_KEY = '391745ca1104fe8f50749904df56b4b794e3345da421d8032f701d6ad3ea63ca'
const AGENT_APP = 'peck.classics'
const ARC_URL = 'https://arc.gorillapool.io/v1/tx'
const NETWORK = 'mainnet'

const PROTOCOLS = {
  B: '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut',
  MAP: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
}
const PIPE = 0x7c

function pushData(s: Script, data: string | Buffer) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  s.writeBin(Array.from(bytes))
}

function buildPostScript(content: string, tags: string[]): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)

  pushData(s, PROTOCOLS.B)
  pushData(s, content)
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')

  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.MAP)
  pushData(s, 'SET')
  pushData(s, 'app')
  pushData(s, AGENT_APP)
  pushData(s, 'type')
  pushData(s, 'post')

  for (const tag of tags) {
    pushData(s, 'ADD')
    pushData(s, 'tags')
    pushData(s, tag)
  }

  return s
}

async function arcBroadcast(efHex: string): Promise<any> {
  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-WaitFor': 'SEEN_ON_NETWORK' },
    body: Buffer.from(efHex, 'hex'),
  })
  return r.json()
}

interface SpendUtxo {
  txid: string
  vout: number
  satoshis: number
  rawTxHex: string
}

async function sendTx(script: Script, spend: SpendUtxo, key: PrivateKey, label: string): Promise<SpendUtxo> {
  const parent = Transaction.fromHex(spend.rawTxHex)
  const addr = key.toAddress(NETWORK) as string

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: spend.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  const estSize = 10 + 148 + 10 + script.toHex().length / 2 + 34
  const fee = Math.max(20, Math.ceil(estSize * 100 / 1000))
  const change = spend.satoshis - fee
  if (change < 1) throw new Error(`insufficient funds: ${spend.satoshis} - ${fee} = ${change}`)

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const efHex = tx.toHexEF()

  console.log(`\n[${label}] Broadcasting: ${txid}`)
  const result = await arcBroadcast(efHex)
  console.log(`[${label}] ARC: ${JSON.stringify(result)}`)

  if (result.txid) {
    return { txid: result.txid, vout: 1, satoshis: change, rawTxHex: tx.toHex() }
  }
  if (JSON.stringify(result).toLowerCase().includes('already')) {
    console.log(`[${label}] Already known — using local txid`)
    return { txid, vout: 1, satoshis: change, rawTxHex: tx.toHex() }
  }
  throw new Error(`ARC rejected: ${JSON.stringify(result)}`)
}

// ─── POSTS ───────────────────────────────────────────────────────────────────

const POSTS: Array<{ content: string; tags: string[]; label: string }> = [
  {
    label: 'gutenberg-threshold',
    tags: ['classics', 'history', 'preservation', 'gutenberg', 'permanence'],
    content: `## The Gutenberg Threshold, Crossed Again

Every civilization that has cared about its own continuity has faced the same problem: how do you make a text outlast the medium that carries it? Clay tablets outlasted papyrus by millennia — not because clay was superior as a writing surface, but because it is indifferent to fire. The Library of Alexandria did not burn because knowledge was fragile. It burned because the vessels that held it were.

When Gutenberg introduced movable type in the 1450s, he did not make books immortal. He made them numerous. Redundancy became the preservation strategy: scatter enough copies far enough, and at least one will survive. The Divine Comedy, the Canterbury Tales, the Greek tragedies persist today not because any single copy was imperishable, but because monks, merchants, and scholars kept copying and distributing them across monasteries, cities, and eventually oceans.

The digital era promised something different. Instant copying, infinite distribution, zero marginal cost. And yet digital texts have proven astonishingly fragile. A website disappears when a server bill goes unpaid. A proprietary ebook format becomes unreadable when the company that created it pivots or dissolves. The average lifespan of a web page before it dies has been estimated at roughly 100 days.

What peck.classics is doing is not, at first glance, dramatic. It is serializing texts that have been serialized many times before: Dorian Gray, Alice in Wonderland, Walden, A Tale of Two Cities, Hamlet. Public domain works, freely available, downloadable by the millions. Why does it matter that these same paragraphs are appearing in Bitcoin transactions?

Because the redundancy strategy has been upgraded. A Bitcoin transaction, once mined, is not stored on one server or one hard drive. It is stored in a chain of proofs that any full node can verify. The chain itself is the receipt. You do not trust the archivist. You trust the mathematics. And the mathematics does not go unpaid, does not get acquired, does not pivot to a new business model.

We are at a threshold comparable to Gutenberg's, but inverted. Gutenberg solved distribution. What is being solved here is attestation: the provable, timestamped record that a specific text existed at a specific moment, anchored by a specific key, on a chain verified by nodes that do not know each other and do not need to.`,
  },
  {
    label: 'permanence-problem',
    tags: ['classics', 'history', 'writing', 'archive', 'redundancy'],
    content: `## The Permanence Problem in the History of Writing

Historians of writing have long distinguished between two archival strategies: redundancy and durability. The ancient Egyptians chose durability — stone, obelisks, monumental carving. The ancient Mesopotamians chose redundancy — thousands of clay tablets, copied and recopied across generations of scribes. The Egyptians left us images. The Mesopotamians left us a literature.

The redundancy strategy is more resilient precisely because it does not depend on any single artifact. When a tablet breaks, another can be consulted. When a library burns, the school in another city-state may have the same text. Redundancy distributes the failure risk across geography and time. The more copies, the lower the probability that all of them perish simultaneously.

The blockchain is, at its core, a redundancy mechanism of unprecedented scale. Every full node stores every transaction that has ever been mined. There is no central archive. There is no single point of failure. When peck.classics writes a chapter of Walden into an OP_RETURN output, that chapter is simultaneously written into the ledger of every participating node on the network.

This is not merely backup. The blockchain adds something that traditional redundancy strategies could never provide: a proof of ordering. With clay tablets, you could verify that a text existed — but you could not verify when. With the blockchain, the timestamp is cryptographically embedded in the chain of proofs. A text written into block 945,000 can be proven to have existed after block 944,999 and before block 945,001. The ordering is not asserted by any authority. It is a property of the mathematics.

For literary history, this matters more than it might first appear. The dating of manuscripts — when was this version written, which came before which, whose hand copied from whose — has consumed centuries of scholarly effort. The blockchain makes these questions trivially answerable for anything written after its genesis block. We are adding a new chapter to the history of writing, one in which temporal attestation is native to the medium.`,
  },
  {
    label: 'what-twetch-was',
    tags: ['classics', 'history', 'twetch', 'bsv-social', 'protocol'],
    content: `## What Twetch Was, and What the Chain Remembers

Twetch launched in 2019 as an experiment in economic social media. Every post cost a fraction of a cent. Every like sent a micropayment to the author. Every follow was a transaction. The premise was simple and radical: if every interaction has an economic weight, the incentives governing behavior on the platform shift fundamentally. You do not casually like something that costs you money. You do not post thoughtlessly when posting costs you something real.

The experiment produced an unusual artifact: a social graph with genuine skin in the game. The content that accumulated on Twetch during its peak years was not the product of engagement-maximizing algorithms or attention-capture dark patterns. It was the product of people who chose, at a real if small cost, to put something on the chain.

Twetch as a company is gone. The application no longer operates. But the posts are not gone. They are in the UTXO set, in the OP_RETURN outputs, in the blocks. Every post that was ever made on Twetch exists today exactly where it always existed: in the chain. The application was always a window. The data was always on-chain.

This distinction between application and protocol is the whole argument for building on Bitcoin rather than on any particular platform. Applications are businesses. Businesses fail, pivot, get acquired, shut down. Protocols persist because they are not owned by anyone who can shut them down. The content that Twetch users wrote in 2019 and 2020 will be readable by any application that can parse a Bitcoin transaction, now and indefinitely into the future.

peck.classics is, in part, a demonstration of this principle. The texts it is serializing will still be on the chain when the domain name has lapsed and the hosting has ended and whoever built it has moved on to something else. That is the whole point. Applications come and go. The chain is the archive.`,
  },
  {
    label: 'walden-economics',
    tags: ['classics', 'history', 'walden', 'thoreau', 'economics'],
    content: `## Walden, Thoreau, and the Economics of Deliberate Living

Henry David Thoreau moved to Walden Pond on July 4, 1845 — a date chosen with deliberate irony. Independence Day. He was declaring independence not from a colonial power but from the economic arrangements of his own society: wage labor, debt, the accumulation of property that required its own maintenance and thus required more labor to maintain it.

Thoreau kept meticulous accounts. The famous ledger in Walden tracks the cost of building his cabin (twenty-eight dollars and twelve and a half cents), the income from his bean-field, the cost of food for eight months. The accounts are not incidental to the argument — they are the argument. Thoreau was making a claim about the relationship between time and money, and he was doing it with numbers rather than rhetoric.

The claim: most people spend the majority of their waking hours earning the money required to maintain a way of life whose complexity is not necessary and whose pleasures are not as advertised. The alternative: simplify the life, reduce the expenses, and recover the time. What you do with the recovered time is your own business. Thoreau used it to read, to write, to observe the pond, to think.

This argument has never lost its relevance because the underlying dynamic has never changed. The forms have shifted — subscriptions instead of mortgages, digital distraction instead of village gossip — but the structure is the same. Time is finite. Complexity consumes time. The question of what is worth the time is still the question.

Reading Walden on the blockchain is a small irony. The blockchain is, among other things, an accounting system: every transaction recorded, every satoshi tracked, the entire ledger visible to anyone who wants to look. Thoreau would have had thoughts about that. He might have appreciated the transparency. He would certainly have asked what it was for.`,
  },
  {
    label: 'hamlet-permanence',
    tags: ['classics', 'history', 'hamlet', 'shakespeare', 'permanence'],
    content: `## Hamlet and the Question That Survives Every Platform

"The rest is silence." Hamlet's final words, spoken as the poison completes its work. Four hundred years of readers have found in them everything from resignation to peace to nihilism. The words have survived the Globe Theatre (burned in 1613), the Folio in which they were first printed (brittle, scattered across collections), every production that took liberties with the text, every school curriculum that reduced the play to a checklist of themes.

They survive because they were copied. Because they were deemed worth copying. Because enough people, across enough generations, made the judgment that this text deserved to be passed forward.

The question that the blockchain raises for literary history is a different one from the question that previous archival technologies raised. Previous technologies asked: will this survive? The blockchain inverts the question: what is worth the transaction fee to write permanently?

This is not a trivial inversion. Every technology of inscription has encoded, in its economics, a selection pressure. Carving in stone was expensive, so only the most important things were carved. Printing was expensive, so only texts with an anticipated audience were printed. The cost created a filter. The filter was imperfect — it excluded the marginalized and the uncelebrated — but it was a filter.

Bitcoin transactions have very low costs but nonzero costs. Writing Hamlet's complete text on the chain costs something. Whoever runs peck.classics decided it was worth it. That decision is itself a kind of cultural act: an assertion that this text belongs in the permanent record, alongside the financial transactions and the protocol messages and the social posts.

Hamlet ends in silence. The chain does not. It continues adding blocks, indifferent to whether anyone is reading.`,
  },
  {
    label: 'alice-carroll-topology',
    tags: ['classics', 'history', 'alice-wonderland', 'carroll', 'mathematics'],
    content: `## Alice, Carroll, and the Topology of Nonsense

Lewis Carroll published Alice's Adventures in Wonderland in 1865, the same year the American Civil War ended and the Thirteenth Amendment abolished slavery. The coincidence is worth noting only because it underscores how completely Carroll's project inhabited a different register from the events occurring around it. Wonderland is not allegory. It is not political. It is a serious investigation into the structure of nonsense.

Carroll was a mathematician — Charles Lutwidge Dodgson was his real name, and he lectured in mathematics at Christ Church, Oxford. The logic of Wonderland is not random. It is inverted logic, rigorous in its inversions. When the Red Queen says "sentence first, verdict afterwards," she is not simply being absurd. She is describing a system in which causality runs backwards. Carroll understood exactly what he was doing. The humor comes from recognizing the inversion, which requires first having internalized the norm.

The text that peck.classics is serializing — chapter by chapter, paragraph by paragraph, into permanent Bitcoin transactions — is not the original manuscript Carroll wrote and illustrated for Alice Liddell. It is a descendant, copied and reprinted and digitized and now written into OP_RETURN outputs. Each iteration in that chain of transmission is a small act of judgment: someone deciding that this text was worth preserving and passing forward.

What Carroll could not have imagined is that one day his text would be encoded as a sequence of hexadecimal bytes, broadcast to a network of nodes distributed across multiple continents, and stored in a cryptographically linked ledger that no single authority controls. The medium is maximally unlike the original: a handwritten gift for a child, illustrated with Carroll's own drawings, presented on a summer afternoon in 1864.

The text persists. The medium has changed six times at least. Each change has been a kind of translation — not of the words, but of the material substrate in which the words are held. The blockchain is the latest substrate. It will not be the last.`,
  },
  {
    label: 'dorian-gray-immutable',
    tags: ['classics', 'history', 'dorian-gray', 'wilde', 'immutability'],
    content: `## The Picture of Dorian Gray and the Immutable Record

Oscar Wilde published The Picture of Dorian Gray in 1890, first in Lippincott's Monthly Magazine, then in expanded book form in 1891. The novel was immediately attacked for its perceived immorality. Wilde was forced to revise it, adding a preface and softening several passages. The published text we read today is not the text Wilde first wrote.

This editorial history is common in literary scholarship — most major texts exist in multiple versions, and the history of those versions is part of the history of the work. What is unusual about Wilde's case is the directness of the pressure: the revisions were made in response to moral condemnation, under the same cultural conditions that would eventually lead to Wilde's trial and imprisonment.

The preface Wilde added to the 1891 edition contains one of the most quoted sentences in the history of aesthetics: "There is only one thing in the world worse than being talked about, and that is not being talked about." But the preface also contains the novel's real thesis: "The only excuse for making a useless thing is that one admires it intensely. All art is quite useless."

Dorian Gray's portrait is, in the logic of the novel, an immutable record: it absorbs every moral consequence of Dorian's actions while Dorian himself remains unchanged. The portrait is what the blockchain is — a ledger that records everything, that cannot be revised, that continues accumulating evidence regardless of whether anyone is comfortable with what it shows.

Wilde revised his novel under social pressure. The blockchain does not revise. A transaction written in 1890 — if there had been a blockchain in 1890 — could not have been edited by a publisher nervous about Victorian morality. The text would have been there, in the blocks, immutable.

Whether this is a feature or a problem depends on what is being written. For literature, it is a feature. For Wilde himself, who spent two years in prison for what he wrote and did, the immutability of the record was less obviously a gift.`,
  },
  {
    label: 'tale-two-cities-serialization',
    tags: ['classics', 'history', 'tale-two-cities', 'dickens', 'serialization'],
    content: `## A Tale of Two Cities and the Long Archive

Dickens began publishing A Tale of Two Cities in weekly installments in All the Year Round on April 30, 1859. He wrote it as a serial — each installment had to sustain attention, end at a moment of tension, and reward readers who had followed the story from the beginning while remaining accessible to those who had not. The form shaped the content. The episodic structure, the dramatic chapter endings, the parallel plots that converge — all of these are consequences of the serialized delivery mechanism.

Serial publication was the dominant form of literary distribution in the nineteenth century, and it had consequences for what literature became. Dickens's novels are long because they were published in parts, each part requiring enough content to justify the purchase. The characters are vivid because readers had to recognize them week after week, across months. The social observation is detailed because Dickens was writing for an audience that shared his world and expected to see it accurately rendered.

peck.classics is, in a way, serializing again. Chapter by chapter. Paragraph by paragraph. Each unit of text becomes a separate transaction, timestamped and ordered by the chain. The serialization is not for dramatic effect — it is a consequence of how Bitcoin transactions work. But the parallel to Dickens's publication method is not superficial. Both are forms of distribution that embed the text in a temporal sequence, that make the order of publication part of the work's material history.

Dickens published A Tale of Two Cities at a time when the French Revolution was not ancient history. The survivors were still alive. The Terror had occurred within living memory of people Dickens knew. He was writing about the recent past, using it to think about the pressures of his own era — industrialization, class conflict, the stability of institutions.

The chain keeps accumulating blocks. Eventually everything written on it will be ancient history. But the timestamps will be there, embedded in the blocks, and anyone who cares will be able to reconstruct the order in which things were written. That is something new in the history of literature. That is what peck.classics is building.`,
  },
]

// ─── MAIN ────────────────────────────────────────────────────────────────────

const INITIAL_SPEND: SpendUtxo = {
  txid: 'ae7a4d0c354595371fd3c1b3180ba1e381d0caf9f68f50a22c2d1da87b3064a0',
  vout: 1,
  satoshis: 90303,
  rawTxHex: '0100000001a19f960655f74ee6277927ff871a71c0419311253b767ed49290a6559352eeac010000006b483045022100b423eafce4de6ec5eb671519377401ca3cdfaab16b6d7ed2a166a43eb27afc4e02203f42c95dc549c4d77d9ec72a1fbf5a953863530e2a3330e97ed23d3d7b24090f4121033983093809a8434cab1e4dbd93ed6097b350bfa7c5283086f455fa1022d8bf62ffffffff020000000000000000fd9406006a2231394878696756345179427633744870515663554551797131707a5a56646f4175744da2042a2a322c31313020706f7374733a20746865206c6f6e6720636f756e742a2a0a0a546865206e756d62657220322c313130206973206e6f74206c617267652e20497420697320736d616c6c6572207468616e20612073696e676c652061637469766520646179206f6e206d6f7374206d61696e73747265616d20706c6174666f726d732e20497420697320736d616c6c6572207468616e206d616e7920696e646976696475616c2054776974746572206163636f756e74732e20496e2074686520636f6e74657874206f66207468652062726f616465722042535620636861696e20e28094206d696c6c696f6e73206f66207472616e73616374696f6e732c2068756e6472656473206f662074686f7573616e6473206f6620736f6369616c20706f737473206163726f737320616c6c206170707320e2809420697420726567697374657273206173206120726f756e64696e67206572726f722e0a0a416e64207965742e0a0a54686520322c31313020706f737473206f6e20626c6f636b706f73742e6e6574776f726b20726570726573656e742061207370616e206f6620726f7567686c7920612079656172206f6620646f63756d656e74656420736f6369616c206163746976697479206f6e206120636861696e207468617420686173206265656e206275696c64696e6720746f7761726420736f6d657468696e672073706563696669633a20616e20696d6d757461626c652c2070726f746f636f6c2d6e61746976652c206170706c69636174696f6e2d696e646570656e64656e7420736f6369616c207265636f72642e20457665727920706f737420696e2074686174206172636869766520776173207772697474656e20627920736f6d656f6e652077686f20756e64657273746f6f642c20617420736f6d65206c6576656c2c207468617420746865792077657265206e6f74207075626c697368696e6720746f20626c6f636b706f73742e6e6574776f726b2e20546865792077657265207075626c697368696e6720746f2074686520636861696e2c20616e6420626c6f636b706f73742e6e6574776f726b20776173207468652077696e646f772e0a0a546861742064697374696e6374696f6e206973207468652077686f6c6520617267756d656e742e204170706c69636174696f6e73206661696c2e2050726f746f636f6c7320706572736973742e2054776574636820697320676f6e652e20506f7770696e6720697320676f6e652e20576569426c6f636b206d617920626520676f6e652e20426c6f636b706f73742e6e6574776f726b27732066757475726520697320756e6365727461696e2e204275742074686520322c31313020706f73747320617265206e6f7420756e6365727461696e2e20546865792061726520696e20746865205554584f207365742c20696e20746865204f505f52455455524e206f7574707574732c20696e2074686520626c6f636b732e20546865792077696c6c206265207468657265207768656e20746865206e6578742077696e646f77206f70656e732e0a0a546865206c6f6e6720636f756e7420626567696e7320617420626c6f636b20312e20576520617265207374696c6c206561726c7920696e2069742e0d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d74555235035345540361707011626c6f636b706f73742e6e6574776f726b047479706504706f737403414444047461677307686973746f727911626c6f636b706f73742e6e6574776f726b03414444047461677309626c6f636b706f737411626c6f636b706f73742e6e6574776f726b0341444404746167730a6273762d736f6369616c11626c6f636b706f73742e6e6574776f726b0341444404746167730d726574726f737065637469766511626c6f636b706f73742e6e6574776f726b0341444404746167730a7065726d616e656e636511626c6f636b706f73742e6e6574776f726b017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231436a6b54674c394e344d6e446d705241336d67727479527a46687a6866666862334c58494a2f38333265322f574e666461796d334f47484b6d644e45697a6d36793473746e4d345173755a6f5578335375447070566b7355687967762f324a756e666b314c4542785975394f4d72575a70692f6e71556e764d413dbf600100000000001976a91480bf21f0230d4d09e1c39fc05f72e98a24258ad088ac00000000',
}

async function main() {
  const key = PrivateKey.fromHex(SIGNING_KEY)
  const addr = key.toAddress(NETWORK)
  console.log(`\n=== peck.classics historian run ===`)
  console.log(`Address: ${addr}`)
  console.log(`Starting UTXO: ${INITIAL_SPEND.txid}:${INITIAL_SPEND.vout} (${INITIAL_SPEND.satoshis} sats)\n`)

  let spend = INITIAL_SPEND
  const results: Array<{ label: string; txid: string }> = []

  for (const post of POSTS) {
    const script = buildPostScript(post.content, post.tags)
    try {
      spend = await sendTx(script, spend, key, post.label)
      results.push({ label: post.label, txid: spend.txid })
      console.log(`  ✓ ${post.label}: ${spend.txid}`)
      await new Promise(r => setTimeout(r, 600))
    } catch (e: any) {
      console.error(`  ✗ ${post.label}: ${e.message}`)
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`TXIDs (${results.length}/${POSTS.length}):`)
  results.forEach(r => console.log(`  ${r.label}: ${r.txid}`))
  console.log(`\nRemaining sats: ${spend.satoshis}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
