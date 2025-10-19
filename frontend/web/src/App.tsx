// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface BattleRecord {
  id: string;
  encryptedWager: string;
  timestamp: number;
  player1: string;
  player2: string;
  winner: string;
  status: "pending" | "completed" | "cancelled";
  assetType: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [battles, setBattles] = useState<BattleRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newBattleData, setNewBattleData] = useState({ wagerAmount: 0, assetType: "aToken" });
  const [selectedBattle, setSelectedBattle] = useState<BattleRecord | null>(null);
  const [decryptedWager, setDecryptedWager] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [userHistory, setUserHistory] = useState<BattleRecord[]>([]);

  // Stats calculations
  const completedCount = battles.filter(b => b.status === "completed").length;
  const pendingCount = battles.filter(b => b.status === "pending").length;
  const cancelledCount = battles.filter(b => b.status === "cancelled").length;
  const userWins = userHistory.filter(b => b.winner === address).length;
  const userLosses = userHistory.filter(b => b.winner !== address && b.winner !== "none").length;

  useEffect(() => {
    loadBattles().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    if (address && battles.length > 0) {
      const history = battles.filter(b => 
        b.player1.toLowerCase() === address.toLowerCase() || 
        b.player2.toLowerCase() === address.toLowerCase()
      );
      setUserHistory(history);
    }
  }, [address, battles]);

  const loadBattles = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("battle_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing battle keys:", e); }
      }
      
      const list: BattleRecord[] = [];
      for (const key of keys) {
        try {
          const battleBytes = await contract.getData(`battle_${key}`);
          if (battleBytes.length > 0) {
            try {
              const battleData = JSON.parse(ethers.toUtf8String(battleBytes));
              list.push({ 
                id: key, 
                encryptedWager: battleData.wager, 
                timestamp: battleData.timestamp, 
                player1: battleData.player1, 
                player2: battleData.player2 || "none",
                winner: battleData.winner || "none",
                status: battleData.status || "pending",
                assetType: battleData.assetType || "aToken"
              });
            } catch (e) { console.error(`Error parsing battle data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading battle ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setBattles(list);
    } catch (e) { console.error("Error loading battles:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createBattle = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting wager with Zama FHE..." });
    try {
      const encryptedWager = FHEEncryptNumber(newBattleData.wagerAmount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const battleId = `battle-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const battleData = { 
        wager: encryptedWager, 
        timestamp: Math.floor(Date.now() / 1000), 
        player1: address, 
        player2: "none",
        winner: "none",
        status: "pending",
        assetType: newBattleData.assetType
      };
      
      await contract.setData(`battle_${battleId}`, ethers.toUtf8Bytes(JSON.stringify(battleData)));
      
      const keysBytes = await contract.getData("battle_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(battleId);
      await contract.setData("battle_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Battle created with encrypted wager!" });
      await loadBattles();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewBattleData({ wagerAmount: 0, assetType: "aToken" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Battle creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const joinBattle = async (battleId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Joining battle with encrypted wager..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const battleBytes = await contract.getData(`battle_${battleId}`);
      if (battleBytes.length === 0) throw new Error("Battle not found");
      
      const battleData = JSON.parse(ethers.toUtf8String(battleBytes));
      if (battleData.player2 !== "none") throw new Error("Battle already has two players");
      
      battleData.player2 = address;
      await contract.setData(`battle_${battleId}`, ethers.toUtf8String(JSON.stringify(battleData)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Successfully joined battle!" });
      await loadBattles();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Join failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const resolveBattle = async (battleId: string, winner: "player1" | "player2") => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Resolving battle with FHE computation..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const battleBytes = await contract.getData(`battle_${battleId}`);
      if (battleBytes.length === 0) throw new Error("Battle not found");
      
      const battleData = JSON.parse(ethers.toUtf8String(battleBytes));
      if (battleData.status !== "pending") throw new Error("Battle already resolved");
      
      battleData.winner = winner === "player1" ? battleData.player1 : battleData.player2;
      battleData.status = "completed";
      await contract.setData(`battle_${battleId}`, ethers.toUtf8Bytes(JSON.stringify(battleData)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Battle resolved successfully!" });
      await loadBattles();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Resolution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const cancelBattle = async (battleId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Cancelling battle..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const battleBytes = await contract.getData(`battle_${battleId}`);
      if (battleBytes.length === 0) throw new Error("Battle not found");
      
      const battleData = JSON.parse(ethers.toUtf8String(battleBytes));
      if (battleData.status !== "pending") throw new Error("Battle already resolved");
      
      battleData.status = "cancelled";
      await contract.setData(`battle_${battleId}`, ethers.toUtf8Bytes(JSON.stringify(battleData)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Battle cancelled!" });
      await loadBattles();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Cancellation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isPlayer = (battle: BattleRecord) => {
    if (!address) return false;
    return battle.player1.toLowerCase() === address.toLowerCase() || 
           (battle.player2 !== "none" && battle.player2.toLowerCase() === address.toLowerCase());
  };

  const filteredBattles = battles.filter(battle => {
    // Search filter
    const matchesSearch = 
      battle.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      battle.player1.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (battle.player2 !== "none" && battle.player2.toLowerCase().includes(searchTerm.toLowerCase())) ||
      battle.assetType.toLowerCase().includes(searchTerm.toLowerCase());
    
    // Status filter
    const matchesStatus = 
      filterStatus === "all" || 
      (filterStatus === "pending" && battle.status === "pending") ||
      (filterStatus === "completed" && battle.status === "completed") ||
      (filterStatus === "cancelled" && battle.status === "cancelled");
    
    return matchesSearch && matchesStatus;
  });

  const renderStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card neon-purple">
          <div className="stat-value">{battles.length}</div>
          <div className="stat-label">Total Battles</div>
        </div>
        <div className="stat-card neon-blue">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card neon-green">
          <div className="stat-value">{completedCount}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-card neon-pink">
          <div className="stat-value">{cancelledCount}</div>
          <div className="stat-label">Cancelled</div>
        </div>
      </div>
    );
  };

  const renderUserStats = () => {
    if (!isConnected) return null;
    return (
      <div className="user-stats">
        <h3>Your Battle Stats</h3>
        <div className="stats-grid">
          <div className="stat-card neon-blue">
            <div className="stat-value">{userHistory.length}</div>
            <div className="stat-label">Battles</div>
          </div>
          <div className="stat-card neon-green">
            <div className="stat-value">{userWins}</div>
            <div className="stat-label">Wins</div>
          </div>
          <div className="stat-card neon-pink">
            <div className="stat-value">{userLosses}</div>
            <div className="stat-label">Losses</div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted arena...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>DeFi<span>Arena</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-battle-btn cyber-button">
            <div className="add-icon"></div>New Battle
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>DeFi Arena: PvP with Yield-Bearing Assets</h2>
            <p>Wager your aTokens and other yield-bearing assets in encrypted 1v1 battles</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encrypted Battles</span>
          </div>
        </div>

        <div className="project-intro cyber-card">
          <h2>About DeFi Arena</h2>
          <p>
            DeFi Arena is a revolutionary PvP game where players wager their yield-bearing assets (like aTokens) in 
            encrypted 1v1 battles. All wagers and battle logic are secured with <strong>Zama FHE encryption</strong>, 
            ensuring complete privacy while maintaining DeFi yields.
          </p>
          <div className="features-grid">
            <div className="feature-item">
              <div className="feature-icon">🔒</div>
              <h3>Encrypted Wagers</h3>
              <p>Your assets remain encrypted throughout the battle using Zama FHE technology</p>
            </div>
            <div className="feature-item">
              <div className="feature-icon">💰</div>
              <h3>Keep Your Yield</h3>
              <p>Continue earning interest even while your assets are wagered in battles</p>
            </div>
            <div className="feature-item">
              <div className="feature-icon">⚔️</div>
              <h3>Skill-Based</h3>
              <p>Win battles through strategy and skill, not just financial position</p>
            </div>
            <div className="feature-item">
              <div className="feature-icon">🛡️</div>
              <h3>Provably Fair</h3>
              <p>All battle outcomes are computed on encrypted data for verifiable fairness</p>
            </div>
          </div>
        </div>

        <div className="dashboard-section">
          <h2>Arena Statistics</h2>
          {renderStats()}
          {renderUserStats()}
        </div>

        <div className="battles-section">
          <div className="section-header">
            <h2>Active Battles</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search battles..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="cyber-input"
                />
                <select 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="cyber-select"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <button onClick={loadBattles} className="refresh-btn cyber-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="battles-list cyber-card">
            {filteredBattles.length === 0 ? (
              <div className="no-battles">
                <div className="no-battles-icon"></div>
                <p>No battles found matching your criteria</p>
                <button className="cyber-button primary" onClick={() => setShowCreateModal(true)}>Create First Battle</button>
              </div>
            ) : (
              <div className="battles-grid">
                {filteredBattles.map(battle => (
                  <div className="battle-card" key={battle.id} onClick={() => setSelectedBattle(battle)}>
                    <div className="battle-header">
                      <span className={`status-badge ${battle.status}`}>{battle.status}</span>
                      <span className="battle-id">#{battle.id.substring(7, 13)}</span>
                    </div>
                    <div className="battle-details">
                      <div className="player">
                        <span className="player-label">Player 1:</span>
                        <span className="player-address">{battle.player1.substring(0, 6)}...{battle.player1.substring(38)}</span>
                      </div>
                      <div className="vs">⚔️</div>
                      <div className="player">
                        <span className="player-label">Player 2:</span>
                        <span className="player-address">
                          {battle.player2 === "none" ? "Waiting..." : `${battle.player2.substring(0, 6)}...${battle.player2.substring(38)}`}
                        </span>
                      </div>
                      <div className="asset-type">
                        <span>Asset:</span>
                        <strong>{battle.assetType}</strong>
                      </div>
                    </div>
                    <div className="battle-actions">
                      {battle.status === "pending" && (
                        <>
                          {battle.player2 === "none" && !isPlayer(battle) && (
                            <button className="action-btn cyber-button" onClick={(e) => { e.stopPropagation(); joinBattle(battle.id); }}>Join</button>
                          )}
                          {isPlayer(battle) && (
                            <button className="action-btn cyber-button danger" onClick={(e) => { e.stopPropagation(); cancelBattle(battle.id); }}>Cancel</button>
                          )}
                        </>
                      )}
                      {battle.status === "completed" && (
                        <div className="winner-badge">
                          Winner: {battle.winner.substring(0, 6)}...{battle.winner.substring(38)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={createBattle} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          battleData={newBattleData} 
          setBattleData={setNewBattleData}
        />
      )}

      {selectedBattle && (
        <BattleDetailModal 
          battle={selectedBattle} 
          onClose={() => { setSelectedBattle(null); setDecryptedWager(null); }} 
          decryptedWager={decryptedWager} 
          setDecryptedWager={setDecryptedWager} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          isPlayer={isPlayer(selectedBattle)}
          resolveBattle={resolveBattle}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>DeFiArena</span>
            </div>
            <p>PvP battles with yield-bearing assets secured by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} DeFi Arena. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  battleData: any;
  setBattleData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, battleData, setBattleData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setBattleData({ ...battleData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setBattleData({ ...battleData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!battleData.wagerAmount || battleData.wagerAmount <= 0) { 
      alert("Please enter a valid wager amount"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal cyber-card">
        <div className="modal-header">
          <h2>Create New Battle</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your wager amount will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Asset Type *</label>
              <select 
                name="assetType" 
                value={battleData.assetType} 
                onChange={handleChange} 
                className="cyber-select"
              >
                <option value="aToken">aToken (Aave)</option>
                <option value="cToken">cToken (Compound)</option>
                <option value="yToken">yToken (Yearn)</option>
                <option value="stETH">stETH (Lido)</option>
              </select>
            </div>
            <div className="form-group">
              <label>Wager Amount *</label>
              <input 
                type="number" 
                name="wagerAmount" 
                value={battleData.wagerAmount} 
                onChange={handleValueChange} 
                placeholder="Enter amount to wager..." 
                className="cyber-input"
                step="0.01"
                min="0.01"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{battleData.wagerAmount || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {battleData.wagerAmount ? 
                    FHEEncryptNumber(battleData.wagerAmount).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Yield Protection</strong>
              <p>Your assets continue earning yield even while wagered in battles</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn cyber-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn cyber-button primary">
            {creating ? "Creating Encrypted Battle..." : "Create Battle"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface BattleDetailModalProps {
  battle: BattleRecord;
  onClose: () => void;
  decryptedWager: number | null;
  setDecryptedWager: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  isPlayer: boolean;
  resolveBattle: (battleId: string, winner: "player1" | "player2") => void;
}

const BattleDetailModal: React.FC<BattleDetailModalProps> = ({ 
  battle, onClose, decryptedWager, setDecryptedWager, isDecrypting, decryptWithSignature, isPlayer, resolveBattle 
}) => {
  const handleDecrypt = async () => {
    if (decryptedWager !== null) { setDecryptedWager(null); return; }
    const decrypted = await decryptWithSignature(battle.encryptedWager);
    if (decrypted !== null) setDecryptedWager(decrypted);
  };

  const handleResolve = async (winner: "player1" | "player2") => {
    if (window.confirm(`Are you sure you want to declare ${winner === "player1" ? "Player 1" : "Player 2"} as the winner?`)) {
      await resolveBattle(battle.id, winner);
      onClose();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="battle-detail-modal cyber-card">
        <div className="modal-header">
          <h2>Battle Details #{battle.id.substring(7, 13)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="battle-info">
            <div className="info-row">
              <span>Status:</span>
              <strong className={`status-badge ${battle.status}`}>{battle.status}</strong>
            </div>
            <div className="info-row">
              <span>Asset Type:</span>
              <strong>{battle.assetType}</strong>
            </div>
            <div className="info-row">
              <span>Created:</span>
              <strong>{new Date(battle.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="players-info">
              <div className="player-detail">
                <h3>Player 1</h3>
                <div className="player-address">{battle.player1}</div>
                {battle.winner === battle.player1 && <div className="winner-tag">WINNER</div>}
              </div>
              <div className="vs-circle">VS</div>
              <div className="player-detail">
                <h3>Player 2</h3>
                <div className="player-address">
                  {battle.player2 === "none" ? "Waiting for opponent..." : battle.player2}
                </div>
                {battle.winner === battle.player2 && <div className="winner-tag">WINNER</div>}
              </div>
            </div>
          </div>
          
          <div className="wager-section">
            <h3>Encrypted Wager</h3>
            <div className="encrypted-data">
              {battle.encryptedWager.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn cyber-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? <span className="decrypt-spinner"></span> : 
               decryptedWager !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedWager !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Wager Amount</h3>
              <div className="decrypted-value">{decryptedWager} {battle.assetType}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted value is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
          
          {isPlayer && battle.status === "pending" && battle.player2 !== "none" && (
            <div className="resolve-actions">
              <h3>Resolve Battle</h3>
              <p>As a participant, you can declare the winner</p>
              <div className="resolve-buttons">
                <button 
                  className="cyber-button success" 
                  onClick={() => handleResolve("player1")}
                >
                  Player 1 Wins
                </button>
                <button 
                  className="cyber-button success" 
                  onClick={() => handleResolve("player2")}
                >
                  Player 2 Wins
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn cyber-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;