import type { ThemeMode } from "../types";

interface ContractSetupModalProps {
  theme: ThemeMode;
  contractAddressInput: string;
  deployNewContractSelected: boolean;
  onContractAddressChange: (value: string) => void;
  onDeployNew: () => void;
  onUseExisting: () => void;
  onToggleTheme: () => void;
}

export function ContractSetupModal({
  theme,
  contractAddressInput,
  onContractAddressChange,
  onDeployNew,
  onUseExisting,
  onToggleTheme,
}: ContractSetupModalProps) {
  return (
    <div className="hv-root" data-theme={theme}>
      <div className="hv-contract-modal-backdrop">
        <div className="hv-contract-modal">
          <div className="hv-contract-modal-head">
            <h2 className="hv-contract-modal-title">Contract Setup</h2>
            <button
              className="hv-theme-toggle"
              type="button"
              onClick={onToggleTheme}
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
          <p className="hv-contract-modal-body">
            Before starting, choose how the demo should work with the Midnight
            DataRegistry contract.
          </p>

          <div className="hv-contract-actions">
            <button
              className="pp-btn pp-btn-ghost pp-btn-full"
              type="button"
              onClick={onDeployNew}
            >
              Deploy New Contract
            </button>

            <div className="pp-contract-addr">
              <label className="pp-contract-addr-label" htmlFor="contract-id">
                Use Existing Contract Address
              </label>
              <input
                id="contract-id"
                className="pp-contract-addr-input"
                value={contractAddressInput}
                onChange={(e) => onContractAddressChange(e.target.value)}
                placeholder="Enter DataRegistry contract address"
              />
            </div>

            <button
              className="pp-btn pp-btn-primary pp-btn-full"
              type="button"
              onClick={onUseExisting}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
