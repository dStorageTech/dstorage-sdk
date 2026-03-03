# dStorage SDK — Project Analysis & Competitive Landscape

---

## What it actually is

A three-layer privacy stack packaged as a single SDK:

1. **Crypto layer** — Deterministic AES-GCM 256 key derived from a wallet signature via PBKDF2
   (100k iterations). Key never leaves the device, never persisted.
2. **Storage layer** — Encrypted blob goes to Arweave or Autonomi (permanent, pay-once).
3. **Chain layer** — Only a cryptographic pointer goes on-chain. On Midnight, even the pointer
   owner is ZK-shielded.

The demo's healthcare angle (insurance card → encrypted storage → ZK proof to a clinic, zero
personal data disclosed) is a smart framing. It concretely demonstrates the value proposition
rather than leaving it abstract. The same pattern generalises to: proof of employment, income
band, age, credentials, qualifications — any "prove X without showing Y" scenario.

---

## What's genuinely strong

**The wallet-derived key model is the biggest differentiator.** Every competitor that does
encrypted user data storage requires their own key management network — their own nodes, their
own token, their own uptime SLA. If their network goes down or gets compromised, users' keys are
at risk. dStorage needs nobody. The encryption key is mathematically derived from a signature the
user already controls. No third-party key custodian, ever. That's an architectural guarantee, not
marketing.

**The adapter pattern is legitimately good SDK design.** Swap `MockStorageAdapter` for
`ArweaveStorageAdapter`, `MockChainAdapter` for `MidnightChainAdapter` — zero application code
changes. Most competitors are opinionated about their own chain. This one isn't.

**The developer API is clean.** Three lines to get started and it works. That matters
disproportionately for adoption.

**The Midnight + ZK combination, if completed, is unique in the market.** No other SDK bundles:
client-side encrypted storage (Arweave) + ZK-shielded on-chain references (Midnight) + ZK claims
generation (prove X without revealing underlying data). Each piece exists separately somewhere,
but not composed into one developer-facing SDK.

---

## Competitive Landscape

### Established competitors

| Project                 | What they do                                                         | Key gap vs dStorage                                                                                    |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Lit Protocol**        | Threshold encryption, programmable access conditions across chains   | Requires their own node network for key management; more powerful but introduces a trusted third party |
| **Verida**              | Web3 personal data network with encrypted storage and identity layer | Opinionated stack with their own identity and chain; not plug-and-play into existing dApps             |
| **Ceramic / ComposeDB** | Mutable decentralised data graph                                     | No first-class encryption; focused on queryability not privacy                                         |
| **Polybase**            | Encrypted decentralised database                                     | More mature but no ZK proof layer; EVM-only                                                            |
| **Secret Network**      | Privacy-preserving smart contracts (computation on encrypted data)   | Requires their chain for everything; much higher integration cost                                      |
| **WeaveDB / Tableland** | Decentralised queryable databases                                    | Not privacy-focused; data is public                                                                    |

---

### ar.io

**What it is:** ar.io is not a storage protocol — it is a _gateway and access layer_ built on top
of Arweave. It provides the infrastructure that makes Arweave data globally accessible at CDN
speeds: 650+ gateway nodes, the ArNS naming system (decentralised DNS for permaweb apps), the
Turbo SDK for fast uploads, and the Wayfinder SDK for optimised content discovery. The network
uses the $ARIO token for gateway operator incentives.

**Overlap with dStorage:**

- Both sit on top of Arweave as a storage layer.
- ar.io's **ArDrive Core JS** library includes encrypted file storage on Arweave, which is the
  most direct area of overlap. ArDrive targets file management (drives, folders, versioning);
  dStorage targets dApp-level user data with ZK proofs and chain references.
- ar.io's gateway network could actually be _complementary_ to dStorage — once dStorage stores
  encrypted blobs on Arweave, ar.io gateways are what makes retrieval fast and resilient.

**Verdict: Infrastructure layer, not a direct privacy competitor.** ar.io is upstream
infrastructure. dStorage could leverage ar.io gateways and the Turbo SDK rather than fighting
them. The ArDrive overlap is real but narrow — ArDrive is a file system product, not a
privacy-first dApp SDK. The user mental model is completely different.

**ar.io edge over dStorage today:** Maturity. 20B+ files stored, 875K+ users, production
gateway network. They've solved the Arweave access reliability problem that dStorage will
eventually need to solve too.

**dStorage edge over ar.io:** ZK proof layer, wallet-derived encryption (no key management
infrastructure), Midnight integration, multi-chain adapter pattern. ar.io has no answer for ZK
claims or privacy-preserving access control.

---

### Storacha (formerly web3.storage)

**What it is:** Storacha is a decentralised _hot storage_ network built on IPFS + Filecoin.
Evolved from Protocol Labs' web3.storage project, now community-driven. Targets developers who
need fast, CDN-level retrieval of decentralised content at scale. Offers subscription pricing
($0–$100/month tiers, then $0.03–$0.15/GB). Has JavaScript, Go, and CLI clients.

**The UCAN system:** Storacha's most interesting technical feature is UCANs (User Controlled
Authorization Networks) — a delegatable, cryptographic capability token system for access
control. Users can grant fine-grained, time-limited, delegatable permissions without a
centralised auth server. This is a genuinely sophisticated access control primitive.

**Critical difference from dStorage:** Storacha stores data on IPFS, which means **data is
public by default**. IPFS is content-addressed but not private. If you upload a file to
Storacha, anyone with the CID can retrieve it. The UCAN layer controls _who you tell_ the CID
to, not who can decrypt the data. There is no encryption layer built in. Privacy is the user's
responsibility.

**Comparison breakdown:**

| Dimension       | dStorage SDK                          | Storacha                         |
| --------------- | ------------------------------------- | -------------------------------- |
| Storage backend | Arweave, Autonomi (permanent)         | Filecoin + IPFS (subscription)   |
| Privacy model   | Encrypted by default, key from wallet | Public by default, no encryption |
| Access control  | On-chain grants + ZK proofs           | UCAN delegation (no encryption)  |
| Pricing model   | Pay once, stored forever              | Monthly subscription             |
| Key management  | None — wallet-derived                 | None needed (data is public)     |
| Retrieval speed | Arweave gateway (improving)           | CDN-level, fast                  |
| ZK proof layer  | Planned (Midnight)                    | None                             |
| Data permanence | Permanent (Arweave)                   | Subscription-dependent           |
| Developer SDK   | TypeScript, adapter pattern           | JS, Go, CLI                      |

**Verdict: Adjacent but structurally different.** Storacha wins on retrieval speed and
operational maturity. dStorage wins on privacy — not as a feature but as an architectural
guarantee. The two are actually targeting different developer needs: Storacha is for apps that
need fast decentralised file hosting (gaming assets, AI training data, media); dStorage is for
apps that need private user data that the developer never sees. A developer choosing Storacha
over dStorage is making a different product — not a better/worse version of the same one.

**The real competitive tension:** Storacha's UCAN system is the closest thing to a sophisticated
access control primitive in the decentralised storage space. If they added client-side encryption
(even optionally), they would eat significantly into dStorage's positioning. Watch for this.

---

## Full competitive matrix

| Feature                            | dStorage SDK  | ar.io / ArDrive | Storacha           | Lit Protocol | Verida       |
| ---------------------------------- | ------------- | --------------- | ------------------ | ------------ | ------------ |
| Encrypted by default               | ✅            | via ArDrive     | ❌                 | ✅           | ✅           |
| Wallet-derived keys (no 3rd party) | ✅            | ❌              | ❌                 | ❌           | ❌           |
| ZK proof layer                     | 🚧 Planned    | ❌              | ❌                 | ❌           | ❌           |
| Permanent storage                  | ✅            | ✅              | ❌                 | ❌           | ❌           |
| Subscription-free                  | ✅            | ✅              | ❌                 | ❌           | ❌           |
| Privacy chain integration          | 🚧 Midnight   | ❌              | ❌                 | multi-chain  | Verida chain |
| Multi-chain / multi-storage        | ✅ (adapters) | Arweave only    | IPFS/Filecoin only | multi-chain  | their stack  |
| Access control                     | On-chain + ZK | ArNS / ArDrive  | UCAN               | programmable | custom       |
| Developer ergonomics               | ✅ 3-line API | moderate        | good               | complex      | moderate     |
| Production maturity                | 🚧 Early      | ✅ Mature       | ✅ Mature          | ✅ Mature    | 🟡 Growing   |
| Key custodian required             | None          | None            | None               | Lit nodes    | Verida nodes |

---

## The honest risks

**1. Blocked on external dependencies.** The most interesting parts — Midnight integration and
Autonomi — are both waiting on external SDKs that aren't stable yet. Autonomi (formerly SAFE
Network) has been "almost ready" for over a decade. Midnight is newer but moving fast. This is a
real execution risk that is outside the team's control.

**2. The grant/revoke model is incomplete.** `grant(dataId, recipientAddress)` currently writes
an on-chain permission record, but the recipient wallet has no way to actually decrypt the
data — they don't have the encryption key. Real selective access sharing requires proxy
re-encryption (encrypt the data key to the recipient's public key). This is the hard
cryptographic problem that Lit Protocol solves with threshold decryption. Until this is
implemented, the access control system is a UI affordance, not a cryptographic guarantee.

**3. Storacha's UCAN could evolve.** If Storacha adds an optional client-side encryption layer
(trivially possible), the UCAN + encryption combination would be a serious competitor with far
more operational maturity. This is the most realistic near-term competitive threat.

**4. Key derivation phishing surface.** The key derivation message is fixed
(`"dStorage key derivation v1\n\nThis signature derives your encryption key..."`). If a user
is tricked into signing that message on a phishing site, an attacker can derive their encryption
key. Standard risk for signature-based key derivation — worth prominent documentation in the
security model and potentially a domain-binding mechanism.

**5. Arweave's public-by-default nature.** Encrypted blobs on Arweave are retrievable by anyone
with the transaction ID. Security entirely depends on the encryption being unbreakable. This is
fine cryptographically — AES-GCM 256 with a PBKDF2-derived key is strong — but the architecture
should be documented clearly so developers don't accidentally expose the `storageId` thinking
it's like an access-controlled URL.

---

## Bottom line

The architecture is sound, the developer experience is clean, and the problem is real and
unsolved. The biggest bet is on Midnight — if that integration lands, dStorage + Midnight becomes
a privacy stack that genuinely doesn't exist anywhere else. The comparison against ar.io and
Storacha confirms that neither is building toward ZK-shielded user data with wallet-derived
encryption; they're optimising for retrieval speed and storage scale instead.

The work to make this production-credible, in order of priority:

1. Real grant/revoke via proxy re-encryption (this makes the access model real)
2. Real Arweave upload + payment integration (Turbo SDK is the path)
3. Real Midnight adapter once Midnight.js v1 lands
4. Real ZK circuits on Midnight (replaces the simulated proof layer)
5. Autonomi adapter once their JS SDK stabilises

The ZK simulation layer in the demo is impressive for communicating the vision. The race is
to close the gap between the vision and the production implementation before a more mature
player (most likely Lit Protocol or an encrypted Storacha) covers the same ground.
