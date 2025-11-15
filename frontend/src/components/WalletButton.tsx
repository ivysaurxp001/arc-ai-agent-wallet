import { useWallet } from "../hooks/useWallet";

export const WalletButton = () => {
  const { address, isConnected, isConnecting, error, connect, disconnect } = useWallet();

  if (isConnected && address) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span className="pill" style={{ backgroundColor: "#4caf50", color: "white" }}>
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <button className="button secondary" type="button" onClick={disconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div>
      <button className="button" type="button" onClick={connect} disabled={isConnecting}>
        {isConnecting ? "Connecting..." : "Connect Wallet"}
      </button>
      {error && <p style={{ color: "red", fontSize: "0.875rem", marginTop: "0.25rem" }}>{error}</p>}
    </div>
  );
};


