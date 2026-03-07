/**
 * @dstorage/chain — mockProofServer.ts
 *
 * Simulates the Midnight proof server — the component that generates
 * Zero-Knowledge proofs for shielded transactions before they are
 * submitted to the Midnight network.
 *
 * In production, the Midnight SDK calls a locally-running or remote proof
 * server over HTTP. This mock replicates that interaction with realistic
 * timing, so developers can observe the full flow without a live network.
 */

export interface MockProof {
  /** Pedersen commitment to the witness data */
  commitment: string;
  /** One-time nullifier — prevents double-spending */
  nullifier: string;
  /** Serialised proof bytes (hex) */
  proofBytes: string;
  /** Name of the ZK circuit used to generate this proof */
  circuit: string;
  /** Simulated proof-server response time in ms */
  provingTimeMs: number;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MockProofServer simulates the Midnight proof server.
 *
 * Usage (internal to MockMidnightChainAdapter — also exported for tests):
 *
 *   const server = new MockProofServer();
 *   const proof = await server.generateProof('storeReference', { storageId, owner });
 */

interface Logger {
  log(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export class MockProofServer {
  /** Minimum simulated proving time in ms */
  private readonly minMs: number;
  /** Maximum simulated proving time in ms */
  private readonly maxMs: number;
  private readonly logger: Logger | undefined;

  constructor(
    options: { minMs?: number; maxMs?: number; logger?: Logger } = {},
  ) {
    this.minMs = options.minMs ?? 300;
    this.maxMs = options.maxMs ?? 800;
    this.logger = options.logger;
  }

  /**
   * Simulate a call to the Midnight proof server.
   * Generates a ZK proof for the given circuit and inputs.
   */
  async generateProof(circuit: string, inputs: unknown): Promise<MockProof> {
    const delay = this.minMs + Math.random() * (this.maxMs - this.minMs);
    const start = Date.now();

    this.logger?.log(
      `[dStorage/proof-server] Generating proof for circuit "${circuit}"…`,
      inputs,
    );

    await sleep(delay);

    const proof: MockProof = {
      commitment: `0x${randomHex(32)}`,
      nullifier: `0x${randomHex(32)}`,
      proofBytes: `0x${randomHex(64)}`,
      circuit,
      provingTimeMs: Date.now() - start,
    };

    this.logger?.log(
      `[dStorage/proof-server] Proof generated in ${proof.provingTimeMs}ms ✓`,
    );

    return proof;
  }
}
