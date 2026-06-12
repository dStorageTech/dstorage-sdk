import { useState, useCallback, useEffect } from "react";
import { DStorage } from "@dstorage-tech/dstorage";
import {
  MnemonicEncryptionAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage/encryption";
import {
  isPrfSupported,
  hasCredential,
  createPrfCredential,
  getPrfSeed,
} from "./lib/webAuthnPrf";
import { INSURANCE_CLAIMS, simulateZkProof } from "./zkProof.js";
import type {
  DataReferenceSummary,
  MetaTxProgress,
} from "@dstorage-tech/dstorage";
import type { ZkProofResult, ZkProofProgress } from "./zkProof.js";
import type {
  AppStep,
  StoredRecord,
  ThemeMode,
  PendingCertificate,
  StorageAdapterKey,
  ChainAdapterKey,
  PaymentAdapterKey,
} from "./types";
import { CHAIN_ADAPTER_CONFIGS } from "./adapterConfigs";
import { buildSDK } from "./buildSDK";
import { PatientPanel } from "./components/PatientPanel.tsx";
import { VerifierPanel } from "./components/VerifierPanel.tsx";
import { SdkDrawer } from "./components/SdkDrawer.tsx";
import { StepIndicator } from "./components/StepIndicator.tsx";
import { ContractSetupModal } from "./components/ContractSetupModal.tsx";
import { CertificatePreviewModal } from "./components/CertificatePreviewModal.tsx";
import { buildCertificatePreview } from "./utils/certificatePreview";

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("demo-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [dstorage, setDStorage] = useState<DStorage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[HealthVault]", err);
    setErrorMessage(msg);
  };
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
  const [paymentAdapterKey, setPaymentAdapterKey] =
    useState<PaymentAdapterKey>("local");
  const [keySource, setKeySource] = useState<
    "webauthn-prf" | "mnemonic" | "demo"
  >("demo");
  const [mnemonic, setMnemonic] = useState("");
  const [demoPassword, setDemoPassword] = useState(
    import.meta.env["VITE_DEMO_PASSWORD"] ?? "",
  );
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null);
  const [managedAuthToken, setManagedAuthToken] = useState(
    import.meta.env["VITE_DSTORAGE_AUTH_TOKEN"] ?? "",
  );
  const managedServiceUrl = "http://localhost:3000";
  const [existingReferences, setExistingReferences] = useState<
    DataReferenceSummary[]
  >([]);
  const [showContractSetupModal, setShowContractSetupModal] = useState(true);
  const [contractAddressInput, setContractAddressInput] = useState("");
  const [selectedContractAddress, setSelectedContractAddress] = useState("");
  const [deployNewContractSelected, setDeployNewContractSelected] =
    useState(false);
  const [pendingCertificate, setPendingCertificate] =
    useState<PendingCertificate | null>(null);
  const [certificatePreviewOpen, setCertificatePreviewOpen] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("demo-theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    isPrfSupported().then(setPrfSupported);
  }, []);

  const releasePendingCertificate = useCallback(
    (cert: PendingCertificate | null) => {
      if (cert?.pdfUrl) {
        URL.revokeObjectURL(cert.pdfUrl);
      }
    },
    [],
  );

  /**
   * Smart connect: initialises the SDK with the selected adapters.
   * sdk.init() handles wallet connection, contract deployment/join, and
   * encryption key derivation via the configured encryptionSeedProvider.
   */
  const ensureSdkReady = useCallback(
    async (forceRegisterPrf = false): Promise<DStorage> => {
      if (dstorage && !forceRegisterPrf) return dstorage;

      let encryptionAdapter;
      if (keySource === "webauthn-prf") {
        const seed =
          !forceRegisterPrf && hasCredential()
            ? await getPrfSeed()
            : await createPrfCredential();
        const seedHex = Array.from(seed, (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        encryptionAdapter = new MnemonicEncryptionAdapter({ seedHex });
      } else if (keySource === "mnemonic") {
        encryptionAdapter = new MnemonicEncryptionAdapter({ mnemonic });
      } else {
        encryptionAdapter = new PasswordEncryptionAdapter({
          password: demoPassword,
          salt: "dstorage:demo:v1",
        });
      }

      const sdk = await buildSDK(
        storageAdapterKey,
        chainAdapterKey,
        paymentAdapterKey,
        {
          managedAuthToken,
          managedServiceUrl,
          selectedContractAddress,
          encryptionAdapter,
        },
      );

      const contractAddress = await sdk.init();
      if (contractAddress) {
        setSelectedContractAddress(contractAddress);
        setContractAddressInput(contractAddress);
        setDeployNewContractSelected(false);
      }

      setDStorage(sdk);
      return sdk;
    },
    [
      chainAdapterKey,
      demoPassword,
      dstorage,
      keySource,
      mnemonic,
      managedServiceUrl,
      managedAuthToken,
      paymentAdapterKey,
      selectedContractAddress,
      storageAdapterKey,
    ],
  );

  const handleRegisterNewPrfCredential = useCallback(async () => {
    setDStorage(null);
    try {
      await ensureSdkReady(true);
      setStep("ready");
    } catch (err) {
      showError(err);
    }
  }, [ensureSdkReady]);

  const refreshExistingReferences = useCallback(
    async (sdk: DStorage): Promise<DataReferenceSummary[]> => {
      try {
        const refs = await sdk.listReferences();
        const allowedProviders =
          storageAdapterKey === "arweave-local"
            ? new Set(["arweave"])
            : new Set([storageAdapterKey]);
        const filtered = refs.filter((ref) =>
          allowedProviders.has(ref.storageProvider),
        );
        setExistingReferences(filtered);
        return filtered;
      } catch (err) {
        showError(err);
        setExistingReferences([]);
        return [];
      }
    },
    [storageAdapterKey],
  );

  const handleContinueFromSetup = () => {
    setStep("ready");
  };

  const handleStartUploadFlow = async () => {
    try {
      const sdk = await ensureSdkReady();
      await refreshExistingReferences(sdk);
      setStep("upload");
    } catch (err) {
      showError(err);
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
        showError(new Error("Reference not found on chain."));
        return;
      }

      const result = await sdk.retrieveByRefId(selected.refId);
      const { preview, previewKind, truncated, pdfUrl } =
        buildCertificatePreview(
          new TextDecoder().decode(result.bytes),
          result.bytes,
        );
      const nextRecord = {
        dataId: `${selected.storageId}::${selected.refId}`,
        storageId: selected.storageId,
        refId: selected.refId,
        fileName: "Existing certificate from on-chain reference",
        uploadedAt: Date.now(),
        chainRefId: selected.refId,
      };
      setPendingCertificate((previous) => {
        releasePendingCertificate(previous);
        return {
          record: nextRecord,
          refId: selected.refId,
          storageId: selected.storageId,
          chainLabel: CHAIN_ADAPTER_CONFIGS[chainAdapterKey].label,
          previewKind,
          preview,
          truncated,
          bytesLength: result.bytes.byteLength,
          ...(pdfUrl ? { pdfUrl } : {}),
        };
      });
      setCertificatePreviewOpen(true);
      setProof(null);
      setVerified(null);
      setVerifying(false);
    } catch (err) {
      showError(err);
    }
  };

  const handleConfirmCertificate = () => {
    if (!pendingCertificate) return;
    setRecord(pendingCertificate.record);
    setCertificatePreviewOpen(false);
    setPendingCertificate((previous) => {
      releasePendingCertificate(previous);
      return null;
    });
    setStep("prove");
  };

  const handleCancelCertificatePreview = () => {
    setCertificatePreviewOpen(false);
    setPendingCertificate((previous) => {
      releasePendingCertificate(previous);
      return null;
    });
  };

  const handleLoadExistingReferences = async () => {
    try {
      const sdk = await ensureSdkReady();
      await refreshExistingReferences(sdk);
    } catch (err) {
      showError(err);
    }
  };

  const handleChainAdapterChange = (next: ChainAdapterKey) => {
    if (next === chainAdapterKey) return;
    dstorage?.destroy();
    setChainAdapterKey(next);
    setDStorage(null);
    setExistingReferences([]);
  };

  const handleStorageAdapterChange = (next: StorageAdapterKey) => {
    if (next === storageAdapterKey) return;
    dstorage?.destroy();
    setStorageAdapterKey(next);
    setDStorage(null);
    setExistingReferences([]);
  };

  const handlePaymentAdapterChange = (next: PaymentAdapterKey) => {
    if (next === paymentAdapterKey) return;
    dstorage?.destroy();
    setPaymentAdapterKey(next);
    setDStorage(null);
  };

  const handleManagedAuthTokenChange = (nextToken: string) => {
    setManagedAuthToken(nextToken);
    if (paymentAdapterKey === "managed") {
      dstorage?.destroy();
      setDStorage(null);
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
        contractAddress: "midnight:contract",
        contractName: "Midnight Data Registry",
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
    dstorage?.destroy();
    setDStorage(null);
    setStep("connect");
    setRecord(null);
    setProof(null);
    setVerified(null);
    setDrawerOpen(false);
    setMetaTxProgress(null);
    setZkProgress(null);
    setMnemonic("");
    setPendingCertificate((previous) => {
      releasePendingCertificate(previous);
      return null;
    });
    setCertificatePreviewOpen(false);
  };

  const handleUseExistingContract = () => {
    const nextAddress = contractAddressInput.trim();
    if (!nextAddress) {
      showError(new Error("Please enter a contract address."));
      return;
    }
    setDeployNewContractSelected(false);
    setSelectedContractAddress(nextAddress);
    setShowContractSetupModal(false);
  };

  const handleDeployNewContract = () => {
    setDeployNewContractSelected(true);
    setSelectedContractAddress("");
    setContractAddressInput("");
    setShowContractSetupModal(false);
  };

  if (showContractSetupModal) {
    return (
      <ContractSetupModal
        theme={theme}
        contractAddressInput={contractAddressInput}
        deployNewContractSelected={deployNewContractSelected}
        onContractAddressChange={setContractAddressInput}
        onDeployNew={handleDeployNewContract}
        onUseExisting={handleUseExistingContract}
        onToggleTheme={() =>
          setTheme((t) => (t === "light" ? "dark" : "light"))
        }
      />
    );
  }

  return (
    <div className="hv-root" data-theme={theme}>
      {errorMessage && (
        <div className="hv-error-banner" role="alert">
          <span className="hv-error-banner-msg">{errorMessage}</span>
          <button
            className="hv-error-banner-close"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}
      <header className="hv-header">
        <div className="hv-header-top">
          <div className="hv-logo">
            <div className="hv-logo-mark">✦</div>
            <div>
              <div className="hv-logo-name">HealthVault</div>
              <div className="hv-logo-sub">Private Medical Records on Web3</div>
            </div>
          </div>
          <StepIndicator step={step} />
          <div className="hv-header-right-top">
            <button
              className="hv-theme-toggle"
              type="button"
              onClick={() =>
                setTheme((t) => (t === "light" ? "dark" : "light"))
              }
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
          </div>
        </div>

        <div className="hv-header-meta">
          <div className="hv-header-left-meta">
            <div className="hv-sdk-badge">
              Powered by <strong>dStorage SDK</strong>
            </div>
          </div>

          <div className="hv-header-center-meta">
            {chainAdapterKey === "midnight-connector" ||
            selectedContractAddress ||
            deployNewContractSelected ? (
              <div className="hv-sdk-badge hv-sdk-badge-contract">
                Contract:{" "}
                <strong>
                  {selectedContractAddress ||
                    "will be deployed on first connect"}
                </strong>
              </div>
            ) : null}
          </div>

          <div className="hv-header-right-meta">
            {(dstorage !== null || step !== "connect") && (
              <button className="hv-reset-btn" onClick={() => handleReset()}>
                New Session
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="hv-main">
        {step === "connect" ? (
          <div className="hv-setup-page">
            <PatientPanel
              step={step}
              connected={dstorage !== null}
              record={record}
              storageAdapterKey={storageAdapterKey}
              chainAdapterKey={chainAdapterKey}
              paymentAdapterKey={paymentAdapterKey}
              managedAuthToken={managedAuthToken}
              managedServiceUrl={managedServiceUrl}
              onStorageAdapterChange={handleStorageAdapterChange}
              onChainAdapterChange={handleChainAdapterChange}
              onPaymentAdapterChange={handlePaymentAdapterChange}
              onManagedAuthTokenChange={handleManagedAuthTokenChange}
              existingReferences={existingReferences}
              onContinueFromSetup={handleContinueFromSetup}
              onStartUploadFlow={handleStartUploadFlow}
              onLoadExistingReferences={handleLoadExistingReferences}
              onUseExistingRecord={handleUseExistingRecord}
              onContinueToProof={handleContinueToProof}
              onUpload={handleUpload}
              onGenerateProof={handleGenerateProof}
              prfSupported={prfSupported}
              keySource={keySource}
              onKeySourceChange={setKeySource}
              mnemonic={mnemonic}
              onMnemonicChange={setMnemonic}
              demoPassword={demoPassword}
              onDemoPasswordChange={setDemoPassword}
              onRegisterNewPrfCredential={handleRegisterNewPrfCredential}
            />
          </div>
        ) : (
          <>
            <div className="hv-panel hv-patient">
              <div className="hv-panel-label">
                <span>👤</span> Patient
              </div>
              <PatientPanel
                step={step}
                connected={dstorage !== null}
                record={record}
                storageAdapterKey={storageAdapterKey}
                chainAdapterKey={chainAdapterKey}
                paymentAdapterKey={paymentAdapterKey}
                managedAuthToken={managedAuthToken}
                managedServiceUrl={managedServiceUrl}
                onStorageAdapterChange={handleStorageAdapterChange}
                onChainAdapterChange={handleChainAdapterChange}
                onPaymentAdapterChange={handlePaymentAdapterChange}
                onManagedAuthTokenChange={handleManagedAuthTokenChange}
                existingReferences={existingReferences}
                onContinueFromSetup={handleContinueFromSetup}
                onStartUploadFlow={handleStartUploadFlow}
                onLoadExistingReferences={handleLoadExistingReferences}
                onUseExistingRecord={handleUseExistingRecord}
                onContinueToProof={handleContinueToProof}
                onUpload={handleUpload}
                onGenerateProof={handleGenerateProof}
                prfSupported={prfSupported}
                keySource={keySource}
                onKeySourceChange={setKeySource}
                mnemonic={mnemonic}
                onMnemonicChange={setMnemonic}
                demoPassword={demoPassword}
                onDemoPasswordChange={setDemoPassword}
                onRegisterNewPrfCredential={handleRegisterNewPrfCredential}
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
          </>
        )}
      </main>

      <SdkDrawer
        open={drawerOpen}
        mode={drawerMode}
        metaTxProgress={metaTxProgress}
        zkProgress={zkProgress}
        storageAdapterKey={storageAdapterKey}
        chainAdapterKey={chainAdapterKey}
        paymentAdapterKey={paymentAdapterKey}
        onToggle={() => setDrawerOpen((o) => !o)}
      />

      {certificatePreviewOpen && (
        <CertificatePreviewModal
          certificate={pendingCertificate}
          onConfirm={handleConfirmCertificate}
          onCancel={handleCancelCertificatePreview}
        />
      )}
    </div>
  );
}
