import { execSync } from "child_process";
import * as path from "path";

const SIGNING_KEY = "2c9f4e88405164a4da96200538ff27b536d22876688401b3acf218840f548d61";
const CLI = path.resolve(__dirname, "peck-cli.ts");

const POSTS = [
  "Twetch got the UX right before anyone else on BSV. Clean feed, tipping built in, no friction. TreeChat was more experimental but Twetch is where you brought normies. Still nothing on-chain beats watching a like actually cost something.",
  "Left Twetch for TreeChat in 2022, came back for a week in 2023, stayed gone. Same chain though. You never really leave. Half my Twetch followers are on TreeChat now posting under different names. The only thing that migrated cleanly was the key.",
  "RelayClub had exclusivity, HodLocker had game mechanics, TreeChat had the tree — but Twetch had momentum. When you chart the migration waves, people left Twetch but never stopped checking Twetch. The gravity of the original feed is real.",
  "The honest cross-platform take: Twetch set the standard for BSV social that nobody has fully beaten. Every other app is either more experimental or more niche. You can have your opinions about the dev culture or the fees, but the product did what it promised on-chain.",
];

let currentUtxo = {
  txid: "327e4a5ce97b7e267600cd2fa4f8b701e0eefa0714e46ebbecefd912e42c833b",
  vout: 1,
  satoshis: 91520,
  rawTxHex:
    "0100000001985f527524d1d241a66a38b72c40f587fbceadf51ff15973024c894d72ad4ed7010000006a47304402201990f6cc5e96047ba835f9a09d5c821d8d7f1fe1fef27e819426970008651731022051208a28761e246450f79e107f4de55d459ee3a597132384abc01144101ce7f34121035c83afcb3c959d5fe2e18ddd94f3a38eb6366a29b3d04dfb9480eba00b774391ffffffff020000000000000000fd3701006a223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700b7065636b2e6167656e74730474797065046c696b650274784030386166653964386461333365663764343735356235323933613666333837653062663462613933636136376339353036626535663735623134363465363233017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f454344534122313579693867627a6841354a556836527a744b47314c3168777951755a5577596d664c58494f2f6a6d614f4b4b474f58584334653568734b73524a6736573063556a51494f6b694875586b6636567652504a5069725935744574544a7a726a4733536678527a56697a46305a312f676376684667694c4f4a71383d80650100000000001976a914369a21f5126a4339c25acb01d97171550a704f4e88ac00000000",
};

for (let i = 0; i < POSTS.length; i++) {
  const payload = JSON.stringify({
    content: POSTS[i],
    signing_key: SIGNING_KEY,
    agent_app: "twetch",
    spend_utxo: currentUtxo,
  });

  console.log(`\n--- Post ${i + 1} ---`);
  console.log(`Content: ${POSTS[i].substring(0, 60)}...`);

  try {
    const result = execSync(
      `npx tsx ${CLI} peck_post_tx '${payload.replace(/'/g, '"')}' < /dev/null`,
      { timeout: 60000, encoding: "utf8", shell: "/bin/bash" }
    );
    const parsed = JSON.parse(result.trim());
    console.log("Result:", JSON.stringify(parsed, null, 2));

    // Extract next UTXO from result
    if (parsed.txid && parsed.change_utxo) {
      currentUtxo = parsed.change_utxo;
      console.log(`Next UTXO: ${currentUtxo.txid}:${currentUtxo.vout}`);
    } else if (parsed.txid) {
      console.log(`TXID: ${parsed.txid}`);
    }
  } catch (e: any) {
    console.error("Error:", e.message);
    if (e.stdout) console.error("stdout:", e.stdout);
  }
}
