#!/usr/bin/env bash
# End-to-end simulation on a local anvil fork of Base Sepolia (no testnet funds, no deployed contracts needed).
# The real MockKeystoneForwarder bytecode is on the fork, so `cre workflow simulate --broadcast` delivers
# reports exactly as it would on Base Sepolia. VRF is a VRFCoordinatorV2_5Mock fulfilled by this script.
#
#   cre/workflow/sim-fork.sh             # KEEP_FORK=1 leaves anvil running (http://127.0.0.1:8546) for the app
#
# Every slow step runs under `timeout` (T=300 s by default) so a stall fails fast; nothing reads stdin.
# Checks: catch from 2 km rejected, catch from 50 m caught, redeem reveals the code to the owner only,
# redeem by a non-owner fails, a second redeem fails, listing after redeem fails.
set -euo pipefail

WF=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$WF/.." && pwd)
export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cre/bin:$PATH" # cre shells out to bun
UPSTREAM=${BASE_SEPOLIA_RPC:-https://sepolia.base.org}
RPC=http://127.0.0.1:8546
T=${T:-300}
TMP=$(mktemp -d)
ANVIL=""
# KEEP_FORK: leave anvil (and $TMP with anvil.log / sim.log) behind; otherwise clean up both.
trap '[[ -z ${KEEP_FORK:-} ]] && { [[ -n $ANVIL ]] && kill $ANVIL 2>/dev/null; rm -rf "$TMP"; }' EXIT
if pgrep -f "anvil .*--port 8546" >/dev/null; then echo "an anvil is already on port 8546; kill it first (pkill -f 'anvil .*--port 8546')"; exit 1; fi

# Anvil's well-known dev keys (fork only).
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
BUSINESS_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
PLAYER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
OTHER_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
CRE_PK=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
BUSINESS=$(cast wallet address $BUSINESS_PK)
LAT=19063702 LON=72867181 # Reliance spawn
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
send() { timeout 120 cast send --rpc-url $RPC --json "$@" </dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="0x1", r; print(r["transactionHash"])'; }
reverts() { ! timeout 120 cast send --rpc-url $RPC "$@" </dev/null >/dev/null 2>&1; }
field() { timeout 60 cast call --rpc-url $RPC "$@" | python3 -c "import sys; print(sys.stdin.read().strip().strip('()').split(', ')[$FIELD].split(' ')[0])"; }

echo "== anvil fork of $UPSTREAM"
# Own log file and no shared stdout, so a kept anvil never holds the caller's pipe open.
anvil --fork-url "$UPSTREAM" --port 8546 --silent </dev/null >"$TMP/anvil.log" 2>&1 &
ANVIL=$!
disown $ANVIL
for _ in $(seq 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
[[ $(cast chain-id --rpc-url $RPC) == 84532 ]] || { echo "anvil fork not up"; exit 1; }

echo "== deploy (VRF mock, campaign manager, CatchManager, CatchReceiver -> MockKeystoneForwarder)"
export VRF_COORDINATOR VRF_SUB_ID
VRF_COORDINATOR=$(cd "$ROOT" && timeout $T forge create --rpc-url $RPC --private-key $DEPLOYER_PK --broadcast --json \
  lib/chainlink-brownie-contracts/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol:VRFCoordinatorV2_5Mock \
  --constructor-args 100000000000000000 1000000000 4000000000000000 | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployedTo"])')
tx=$(send "$VRF_COORDINATOR" "createSubscription()" --private-key $DEPLOYER_PK)
VRF_SUB_ID=$(timeout 60 cast receipt --rpc-url $RPC --json "$tx" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["logs"][0]["topics"][1], 16))')
out=$(cd "$ROOT" && timeout $T forge script script/Deploy.s.sol --sig "localStack()" --rpc-url $RPC --private-key $DEPLOYER_PK --broadcast 2>&1) ||
  { echo "$out" | tail -20; exit 1; }
eval "$(grep -oE '(CAMPAIGN_MANAGER|CATCH_MANAGER|CATCH_RECEIVER)=0x[0-9a-fA-F]{40}' <<<"$out")"
echo "CatchManager $CATCH_MANAGER, CatchReceiver $CATCH_RECEIVER"

echo "== keys and encrypted codes (friend's e1 format, AAD bound to this campaign manager + business)"
eval "$(cd "$WF/referee" && timeout $T bun -e '
import { gcm } from "@noble/ciphers/aes";
import nacl from "tweetnacl";
import { codeAad } from "./referee.ts";
const [cm, business] = process.argv.slice(1);
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const key = crypto.getRandomValues(new Uint8Array(32));
const wf = nacl.box.keyPair(), player = nacl.box.keyPair();
console.log(`CODE_KEY=${Buffer.from(key).toString("base64")} BOX_SK=${hex(wf.secretKey)} BOX_PK=${hex(wf.publicKey)}`);
console.log(`PLAYER_BOX_SK=${hex(player.secretKey)} PLAYER_BOX_PK=${hex(player.publicKey)}`);
["COM10", "RAR10", "EPI10", "LEG10"].forEach((code, r) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(key, iv, codeAad(84532, cm, business, r)).encrypt(new TextEncoder().encode(code));
  console.log(`ENC${r}=e1.${Buffer.from([...iv, ...ct]).toString("base64url")}`);
});' "$CAMPAIGN_MANAGER" "$BUSINESS")"
cat >"$TMP/.env" <<EOF
CRE_ETH_PRIVATE_KEY=$CRE_PK
CODE_ENCRYPTION_KEY_ALL=$CODE_KEY
WORKFLOW_BOX_SK_ALL=$BOX_SK
EOF
python3 - "$WF/referee/config.json" "$TMP/config.json" "$CATCH_MANAGER" "$CAMPAIGN_MANAGER" "$CATCH_RECEIVER" <<'EOF'
import json, sys
src, dst, cm, camp, rec = sys.argv[1:]
c = json.load(open(src)); c.update(catchManager=cm, campaignManager=camp, catchReceiver=rec)
json.dump(c, open(dst, "w"), indent=2)
EOF

sim() { # trigger-index tx-hash: fully non-interactive (trigger, tx and log index all given as flags)
  local rc=0
  (cd "$WF" && timeout $T cre workflow simulate referee --target fork-settings --non-interactive --broadcast \
    --trigger-index "$1" --evm-tx-hash "$2" --evm-event-index 0 --config "$TMP/config.json" -e "$TMP/.env" \
    </dev/null >"$TMP/sim.log" 2>&1) || rc=$?
  grep -E "\[USER LOG\]|rror" "$TMP/sim.log" || true
  if ((rc)); then
    echo "cre workflow simulate exited $rc$( ((rc == 124)) && echo " (timed out after $T s)"); last lines:"
    tail -20 "$TMP/sim.log"
    exit 1
  fi
}

echo "== business creates a campaign (encrypted rewards), VRF allocates rarities"
send "$CAMPAIGN_MANAGER" \
  "createCampaign((string,string,int32,int32,uint64,uint32,uint32[4],(string,string)[4]))" \
  "(Reliance,bd302c38bc1dc7e34646473c3d0a9d2d4444eb03bce35ccccd1e339e7b49ae1c,$LAT,$LON,0,4,[1,1,1,1],[($ENC0,Testing),($ENC1,Testing),($ENC2,Testing),($ENC3,Testing)])" \
  --private-key $BUSINESS_PK >/dev/null
send "$VRF_COORDINATOR" "fulfillRandomWords(uint256,address)" 1 "$CAMPAIGN_MANAGER" --private-key $DEPLOYER_PK >/dev/null
ATTEMPT_SIG="getAttempt(uint256)((address,uint8,uint64,uint32,uint256,uint256,uint256))"

echo "== catch from 2 km away"
tx=$(send "$CATCH_MANAGER" "requestCatch(uint256,int32,int32,bytes)" 1 $((LAT + 18000)) $LON 0x --private-key $PLAYER_PK)
sim 0 "$tx"
[[ $(FIELD=1 field "$CATCH_MANAGER" "$ATTEMPT_SIG" 1) == 5 ]] && pass "2 km catch rejected (REJECTED)" || bad "2 km catch not rejected"

echo "== catch from 50 m"
tx=$(send "$CATCH_MANAGER" "requestCatch(uint256,int32,int32,bytes)" 1 $((LAT + 450)) $LON 0x --private-key $PLAYER_PK)
sim 0 "$tx"
[[ $(FIELD=1 field "$CATCH_MANAGER" "$ATTEMPT_SIG" 2) == 2 ]] && pass "50 m catch verified by CRE (ROLLING)" || bad "50 m catch not verified"
send "$VRF_COORDINATOR" "fulfillRandomWords(uint256,address)" 2 "$CATCH_MANAGER" --private-key $DEPLOYER_PK >/dev/null
CREATURE=$(FIELD=6 field "$CATCH_MANAGER" "$ATTEMPT_SIG" 2)
[[ $(FIELD=1 field "$CATCH_MANAGER" "$ATTEMPT_SIG" 2) == 3 ]] && pass "caught creature $CREATURE (VRF)" || bad "VRF did not resolve the catch"

echo "== redeem"
reverts "$CATCH_MANAGER" "requestRedeem(uint256,bytes32)" "$CREATURE" "$PLAYER_BOX_PK" --private-key $OTHER_PK &&
  pass "redeem by non-owner reverts" || bad "non-owner could request a redeem"
tx=$(send "$CATCH_MANAGER" "requestRedeem(uint256,bytes32)" "$CREATURE" "$PLAYER_BOX_PK" --private-key $PLAYER_PK)
sim 1 "$tx"
RARITY=$(FIELD=3 field "$CATCH_MANAGER" "getCaught(uint256)((address,uint64,uint64,uint8,uint256))" "$CREATURE")
SEALED=$(timeout 60 cast call --rpc-url $RPC "$CATCH_MANAGER" "sealedCodes(uint256)(bytes)" "$CREATURE")
CODES=(COM10 RAR10 EPI10 LEG10)
opened=$(cd "$WF/referee" && timeout $T bun -e '
import nacl from "tweetnacl";
import { hexToBytes } from "viem";
import { boxNonce } from "./referee.ts";
const [sealed, id, wfPk, playerSk, otherSk] = process.argv.slice(1);
const open = (sk) => nacl.box.open(hexToBytes(sealed), boxNonce(BigInt(id)), hexToBytes(wfPk), hexToBytes(sk));
const mine = open(playerSk);
console.log(mine ? new TextDecoder().decode(mine) : "NONE", open(otherSk) ? "LEAK" : "SEALED");
' "${SEALED:-0x}" "$CREATURE" "$BOX_PK" "$PLAYER_BOX_SK" "0x$(openssl rand -hex 32)" 2>&1 || true)
echo "player opens: $opened (expected ${CODES[$RARITY]})"
[[ $opened == "${CODES[$RARITY]} SEALED" ]] && pass "code revealed to the owner only" || bad "code reveal"
[[ $(timeout 60 cast call --rpc-url $RPC "$CATCH_MANAGER" "redeemed(uint256)(bool)" "$CREATURE") == true ]] && pass "redeemed flag set" || bad "not redeemed"
reverts "$CATCH_MANAGER" "requestRedeem(uint256,bytes32)" "$CREATURE" "$PLAYER_BOX_PK" --private-key $PLAYER_PK &&
  pass "second redeem reverts" || bad "second redeem accepted"
reverts "$CATCH_MANAGER" "list(uint256,uint256)" "$CREATURE" 1000 --private-key $PLAYER_PK &&
  pass "listing after redeem reverts" || bad "listed a redeemed creature"

if [[ -n ${KEEP_FORK:-} ]]; then
  echo "Fork kept (pid $ANVIL, log $TMP/anvil.log; stop with: kill $ANVIL): NEXT_PUBLIC_BASE_SEPOLIA_RPC=$RPC NEXT_PUBLIC_CATCH_MANAGER=$CATCH_MANAGER"
  echo "NEXT_PUBLIC_CAMPAIGN_MANAGER=$CAMPAIGN_MANAGER NEXT_PUBLIC_WORKFLOW_BOX_PUBKEY=$BOX_PK BUSINESS=$BUSINESS"
fi
exit $fail
