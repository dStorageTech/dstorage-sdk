import { useState, useCallback, useEffect } from "react";
import {
  DStorage,
  MockStorageAdapter,
  ArweaveStorageAdapter,
  ArweaveLocalStorageAdapter,
  AutonomiStorageAdapter,
  MockMidnightChainAdapter,
  MidnightChainAdapter,
  connectDemoWallet,
  INSURANCE_CLAIMS,
  simulateZkProof,
  MockPaymentAdapter,
} from "@dstorage/core";
import type {
  WalletInfo,
  MetaTxProgress,
  ZkProofResult,
  ZkProofProgress,
} from "@dstorage/core";
import { PatientPanel } from "./components/PatientPanel.tsx";
import { VerifierPanel } from "./components/VerifierPanel.tsx";
import { SdkDrawer } from "./components/SdkDrawer.tsx";

export type AppStep = "connect" | "upload" | "uploaded" | "prove" | "done";
export interface StoredRecord {
  dataId: string;
  storageId: string;
  refId: string;
  fileName: string;
  uploadedAt: number;
  chainRefId: string;
}
type ThemeMode = "light" | "dark";
type ExistingReference = {
  refId: string;
  storageId: string;
  storageProvider: string;
};

export type StorageAdapterKey =
  | "mock"
  | "arweave-local"
  | "arweave"
  | "autonomi";
export type ChainAdapterKey = "mock" | "midnight-connector";

const DATA_REGISTRY_CNTRACT_ADDR =
  "e4ca9d7f3ee5ac206b0808cb1a2de992ece1369b1bb18753e728665724eaecd9";
const PROOF_SERVER_ENDPOINT = "http://127.0.0.1:6300";

export const ADAPTER_CONFIGS: Record<
  StorageAdapterKey,
  {
    label: string;
    description: string;
    status: "live" | "preview" | "stub";
    note?: string;
  }
> = {
  mock: {
    label: "Mock",
    description:
      "In-memory store, no network. Instant — ideal for development.",
    status: "live",
  },
  "arweave-local": {
    label: "Arweave Local",
    description: "Local arlocal node — real Arweave flow, no AR tokens needed.",
    status: "live",
    note: "docker run -d --rm -p 1984:1984 textury/arlocal  (or: npx arlocal)",
  },
  arweave: {
    label: "Arweave",
    description: "Pay-once permanent storage on the permaweb.",
    status: "preview",
    note: "Requires the ArConnect browser extension",
  },
  autonomi: {
    label: "Autonomi",
    description:
      "Self-encrypting decentralised network. Memory-backed in this preview.",
    status: "stub",
  },
};

export const CHAIN_ADAPTER_CONFIGS: Record<
  ChainAdapterKey,
  {
    label: string;
    description: string;
    status: "live" | "preview" | "stub";
    note?: string;
  }
> = {
  mock: {
    label: "Mock Midnight",
    description:
      "Simulated Midnight chain. Instant transactions — ideal for development.",
    status: "live",
  },
  "midnight-connector": {
    label: "Midnight Network",
    description: "Real Midnight network via browser wallet extension.",
    status: "live",
    note: "Requires Midnight Lace wallet extension",
  },
};

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("demo-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [dstorage, setDStorage] = useState<DStorage | null>(null);
  const [step, setStep] = useState<AppStep>("connect");
  const [record, setRecord] = useState<StoredRecord | null>(null);
  const [proof, setProof] = useState<ZkProofResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [metaTxProgress, setMetaTxProgress] = useState<MetaTxProgress | null>(
    null,
  );
  const [zkProgress, setZkProgress] = useState<ZkProofProgress | null>(null);
  const [drawerMode, setDrawerMode] = useState<"metatx" | "zkproof">("metatx");
  const [storageAdapterKey, setStorageAdapterKey] =
    useState<StorageAdapterKey>("mock");
  const [chainAdapterKey, setChainAdapterKey] =
    useState<ChainAdapterKey>("mock");
  const [existingReferences, setExistingReferences] = useState<
    ExistingReference[]
  >([]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("demo-theme", theme);
    }
  }, [theme]);

  const buildSDK = useCallback(
    async (storageKey: StorageAdapterKey, chainKey: ChainAdapterKey) => {
      let storageAdapter;
      if (storageKey === "arweave-local") {
        // Auto-generate a test JWK wallet and mint AR tokens via arlocal — no ArConnect needed.
        const { adapter } =
          await ArweaveLocalStorageAdapter.createWithTestWallet();
        storageAdapter = adapter;
      } else {
        storageAdapter =
          storageKey === "arweave"
            ? new ArweaveStorageAdapter()
            : storageKey === "autonomi"
              ? new AutonomiStorageAdapter()
              : new MockStorageAdapter();
      }

      let chainAdapter;
      let chainPaymentAdapter;
      if (chainKey === "midnight-connector") {
        // MidnightChainAdapter in connector mode is browser-safe.
        // All Node.js-only imports inside midnight.ts are /* @vite-ignore */ dynamic
        // imports that are never executed in connector mode.
        chainAdapter = new MidnightChainAdapter({
          walletMode: "connector",
          network: "preprod",
          contractAddress: DATA_REGISTRY_CNTRACT_ADDR,
          nodeEndpoint: "",
          nodeWsEndpoint: "",
          indexerEndpoint: "",
          indexerWsEndpoint: "",
          proofServerEndpoint: PROOF_SERVER_ENDPOINT,
          // ZK artifacts are served from public/keys/ and public/zkir/
          zkConfigBaseUrl: window.location.origin,
        });
        // Midnight fees are managed internally by the Lace wallet — no separate payment adapter.
      } else {
        chainAdapter = new MockMidnightChainAdapter();
        chainPaymentAdapter = new MockPaymentAdapter({ token: "DUST" });
      }

      const dstorageConfig: any = {
        storageAdapter,
        chainAdapter,
        ...(chainPaymentAdapter ? { chainPaymentAdapter } : {}),
      };

      return { sdk: new DStorage(dstorageConfig) };
    },
    [],
  );

  /**
   * Smart connect: uses the selected adapters without forcing a specific wallet.
   * For Arweave adapters, requests ArConnect to get the real wallet address for minting.
   * For Midnight connector: calls sdk.init() which connects to the Lace wallet and
   * deploys/joins the DataRegistry contract, then uses a demo wallet for encryption.
   */
  const ensureSdkReady = useCallback(async (): Promise<DStorage> => {
    if (dstorage) return dstorage;

    const { sdk } = await buildSDK(storageAdapterKey, chainAdapterKey);

    if (chainAdapterKey === "midnight-connector") {
      await sdk.init();
    }

    const connectedWallet = await connectDemoWallet();
    await sdk.connect(connectedWallet);
    setWallet(connectedWallet);
    setDStorage(sdk);
    return sdk;
  }, [buildSDK, chainAdapterKey, dstorage, storageAdapterKey]);

  const refreshExistingReferences = useCallback(
    async (sdk: DStorage): Promise<ExistingReference[]> => {
      try {
        const refs = await sdk.listReferences();
        setExistingReferences(refs);
        return refs;
      } catch {
        setExistingReferences([]);
        return [];
      }
    },
    [],
  );

  const handleStartUploadFlow = async () => {
    try {
      const sdk = await ensureSdkReady();
      await refreshExistingReferences(sdk);
      setStep("upload");
    } catch (err) {
      console.error("Connection failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Connection failed:\n${msg}`);
    }
  };

  const handleUseExistingRecord = async (refId: string) => {
    try {
      const sdk = await ensureSdkReady();
      const refs =
        existingReferences.length > 0
          ? existingReferences
          : await refreshExistingReferences(sdk);
      const selected = refs.find((r) => r.refId === refId);
      if (!selected) {
        alert("Reference not found on chain.");
        return;
      }

      setRecord({
        dataId: `${selected.storageId}::${selected.refId}`,
        storageId: selected.storageId,
        refId: selected.refId,
        fileName: "Existing on-chain reference",
        uploadedAt: Date.now(),
        chainRefId: selected.refId,
      });
      setProof(null);
      setVerified(null);
      setVerifying(false);
      setStep("prove");
    } catch (err) {
      console.error("Failed to load references:", err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to load references:\n${msg}`);
    }
  };

  const handleLoadExistingReferences = async () => {
    try {
      const sdk = await ensureSdkReady();
      await refreshExistingReferences(sdk);
    } catch (err) {
      console.error("Failed to load references:", err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to load references:\n${msg}`);
    }
  };

  const handleUpload = async (file: File) => {
    if (!dstorage) return;
    setDrawerMode("metatx");
    setMetaTxProgress(null);
    setDrawerOpen(true);
    const receipt = await dstorage.executeMetaTransaction(
      file,
      (p) => setMetaTxProgress({ ...p }),
      {
        contractAddress: "midnight:mock-contract",
        contractName: "Midnight Identity Registry",
        circuitId: "storeReference",
        circuitName: "Store Reference",
        metadata: { "record-type": "insurance", app: "healthvault" },
      },
    );
    setRecord({
      dataId: receipt.dataId,
      storageId: receipt.storageId,
      refId: receipt.chainRefId,
      fileName: receipt.file.name,
      uploadedAt: receipt.completedAt,
      chainRefId: receipt.chainRefId,
    });
    await refreshExistingReferences(dstorage);
    setStep("uploaded");
  };

  const handleContinueToProof = () => {
    setStep("prove");
  };

  const handleGenerateProof = async (claimId: string) => {
    if (!record) return;
    const claim = INSURANCE_CLAIMS.find((c) => c.id === claimId);
    if (!claim) return;
    setDrawerMode("zkproof");
    setZkProgress(null);
    setDrawerOpen(true);
    const result = await simulateZkProof(
      claim,
      record.chainRefId,
      "midnight",
      (p) => setZkProgress({ ...p }),
    );
    setProof(result);
    setStep("done");
    setVerifying(true);
    await new Promise((r) => setTimeout(r, 1800));
    setVerified(result.proofValid);
    setVerifying(false);
  };

  const handleReset = async () => {
    dstorage?.disconnect();
    setWallet(null);
    setDStorage(null);
    setStep("connect");
    setRecord(null);
    setProof(null);
    setVerified(null);
    setDrawerOpen(false);
    setMetaTxProgress(null);
    setZkProgress(null);
  };

  return (
    <div className="hv-root" data-theme={theme}>
      <header className="hv-header">
        <div className="hv-logo">
          <div className="hv-logo-mark">✦</div>
          <div>
            <div className="hv-logo-name">HealthVault</div>
            <div className="hv-logo-sub">Private Medical Records on Web3</div>
          </div>
        </div>
        <StepIndicator step={step} />
        <div className="hv-header-right">
          <button
            className="hv-theme-toggle"
            type="button"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            aria-pressed={theme === "dark"}
            title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          >
            <span className="hv-theme-track">
              <span
                className={`hv-theme-thumb ${theme === "dark" ? "is-dark" : ""}`}
              />
            </span>
            <span className="hv-theme-label">
              {theme === "dark" ? "Dark" : "Light"}
            </span>
          </button>
          <div className="hv-sdk-badge">
            Powered by <strong>dStorage SDK</strong>
          </div>
          {(wallet || step !== "connect") && (
            <button className="hv-reset-btn" onClick={() => handleReset()}>
              New Session
            </button>
          )}
        </div>
      </header>

      <main className={`hv-main ${drawerOpen ? "drawer-open" : ""}`}>
        <div className="hv-panel hv-patient">
          <div className="hv-panel-label">
            <span>👤</span> Patient
          </div>
          <PatientPanel
            step={step}
            wallet={wallet}
            record={record}
            storageAdapterKey={storageAdapterKey}
            chainAdapterKey={chainAdapterKey}
            onStorageAdapterChange={setStorageAdapterKey}
            onChainAdapterChange={setChainAdapterKey}
            existingReferences={existingReferences}
            onStartUploadFlow={handleStartUploadFlow}
            onLoadExistingReferences={handleLoadExistingReferences}
            onUseExistingRecord={handleUseExistingRecord}
            onContinueToProof={handleContinueToProof}
            onUpload={handleUpload}
            onGenerateProof={handleGenerateProof}
          />
        </div>
        <div className="hv-divider">
          <div className="hv-div-line" />
          <div className="hv-div-icon">⇄</div>
          <div className="hv-div-line" />
        </div>
        <div className="hv-panel hv-verifier">
          <div className="hv-panel-label">
            <span>🏥</span> Clinic / Verifier
          </div>
          <VerifierPanel
            step={step}
            proof={proof}
            verifying={verifying}
            verified={verified}
          />
        </div>
      </main>

      <SdkDrawer
        open={drawerOpen}
        mode={drawerMode}
        metaTxProgress={metaTxProgress}
        zkProgress={zkProgress}
        storageAdapterKey={storageAdapterKey}
        onToggle={() => setDrawerOpen((o) => !o)}
      />
    </div>
  );
}

function StepIndicator({ step }: { step: AppStep }) {
  const steps = [
    { id: "connect", label: "Choose Adapters" },
    { id: "upload", label: "Upload Certificate" },
    { id: "uploaded", label: "Upload Summary" },
    { id: "prove", label: "Generate Proof" },
    { id: "done", label: "Verified" },
  ] as const;
  const idx = steps.findIndex((s) => s.id === step);
  return (
    <div className="hv-stepper">
      {steps.map((s, i) => {
        const words = s.label.split(" ");
        const splitAt = Math.ceil(words.length / 2);
        const line1 = words.slice(0, splitAt).join(" ");
        const line2 = words.slice(splitAt).join(" ");
        return (
          <div key={s.id} className="hv-step">
            <div
              className={`hv-step-dot ${i < idx ? "past" : i === idx ? "active" : "future"}`}
            >
              {i < idx ? "✓" : i + 1}
            </div>
            <div className="hv-step-text">
              <span className={`hv-step-lbl ${i === idx ? "active" : ""}`}>
                {line1}
              </span>
              <span className={`hv-step-lbl ${i === idx ? "active" : ""}`}>
                {line2 || "\u00A0"}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`hv-step-line ${i < idx ? "past" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
