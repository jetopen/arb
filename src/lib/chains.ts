import type { ChainInfo } from "./types";

export const SUPPORTED_CHAINS: ChainInfo[] = [
  { id: 1, name: "Ethereum", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/1/native/big/token-logo.png", color: "#627EEA", explorerTxUrl: "https://etherscan.io/tx" },
  { id: 10, name: "Optimism", symbol: "OP", logoUrl: "https://tokens.debridge.finance/Logo/10/native/big/token-logo.png", color: "#FF0420", explorerTxUrl: "https://optimistic.etherscan.io/tx" },
  { id: 56, name: "BNB Chain", symbol: "BNB", logoUrl: "https://tokens.debridge.finance/Logo/56/native/big/token-logo.png", color: "#F3BA2F", explorerTxUrl: "https://bscscan.com/tx" },
  { id: 100, name: "Gnosis", symbol: "XDAI", logoUrl: "https://tokens.debridge.finance/Logo/100/native/big/token-logo.png", color: "#04795B", explorerTxUrl: "https://gnosisscan.io/tx" },
  { id: 128, name: "Heco", symbol: "HT", logoUrl: "https://tokens.debridge.finance/Logo/128/native/big/token-logo.png", color: "#25AAE1", explorerTxUrl: "https://hecoinfo.com/tx" },
  { id: 137, name: "Polygon", symbol: "MATIC", logoUrl: "https://tokens.debridge.finance/Logo/137/native/big/token-logo.png", color: "#8247E5", explorerTxUrl: "https://polygonscan.com/tx" },
  { id: 250, name: "Fantom", symbol: "FTM", logoUrl: "https://tokens.debridge.finance/Logo/250/native/big/token-logo.png", color: "#1969FF", explorerTxUrl: "https://ftmscan.com/tx" },
  { id: 324, name: "Zilliqa", symbol: "ZIL", logoUrl: "https://tokens.debridge.finance/Logo/324/native/big/token-logo.png", color: "#49BEB7", explorerTxUrl: "https://viewblock.io/zilliqa/tx" },
  { id: 489, name: "Zircuit", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/489/native/big/token-logo.png", color: "#5D5FEF", explorerTxUrl: "https://explorer.zircuit.com/tx" },
  { id: 747, name: "Flow", symbol: "FLOW", logoUrl: "https://tokens.debridge.finance/Logo/747/native/big/token-logo.png", color: "#00EF8B", explorerTxUrl: "https://flowscan.org/tx" },
  { id: 8453, name: "Base", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/8453/native/big/token-logo.png", color: "#0052FF", explorerTxUrl: "https://basescan.org/tx" },
  { id: 1088, name: "Metis", symbol: "METIS", logoUrl: "https://tokens.debridge.finance/Logo/1088/native/big/token-logo.png", color: "#00D2FF", explorerTxUrl: "https://andromeda-explorer.metis.io/tx" },
  { id: 1890, name: "LightLink", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/1890/native/big/token-logo.png", color: "#00A3FF", explorerTxUrl: "https://phoenix.lightlink.io/tx" },
  { id: 2592, name: "Bitrock", symbol: "BROCK", logoUrl: "https://tokens.debridge.finance/Logo/2592/native/big/token-logo.png", color: "#00D1AE", explorerTxUrl: "https://explorer.bit-rock.io/tx" },
  { id: 4157, name: "CrossFi", symbol: "XFI", logoUrl: "https://tokens.debridge.finance/Logo/4157/native/big/token-logo.png", color: "#00D4FF", explorerTxUrl: "https://scan.crossfi.io/tx" },
  { id: 5000, name: "Mantle", symbol: "MNT", logoUrl: "https://tokens.debridge.finance/Logo/5000/native/big/token-logo.png", color: "#000000", explorerTxUrl: "https://explorer.mantle.xyz/tx" },
  { id: 59144, name: "Linea", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/59144/native/big/token-logo.png", color: "#61DFFF", explorerTxUrl: "https://lineascan.build/tx" },
  { id: 60808, name: "BOB", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/60808/native/big/token-logo.png", color: "#000000", explorerTxUrl: "https://explorer.gobob.xyz/tx" },
  { id: 713715, name: "Sei", symbol: "SEI", logoUrl: "https://tokens.debridge.finance/Logo/713715/native/big/token-logo.png", color: "#9B1C2E", explorerTxUrl: "https://seitrace.com/tx" },
  { id: 7565164, name: "Solana", symbol: "SOL", logoUrl: "https://tokens.debridge.finance/Logo/7565164/native/big/token-logo.png", color: "#9945FF", explorerTxUrl: "https://solscan.io/tx" },
  { id: 757598, name: "Injective", symbol: "INJ", logoUrl: "https://tokens.debridge.finance/Logo/757598/native/big/token-logo.png", color: "#00F2FE", explorerTxUrl: "https://explorer.injective.network/tx" },
  { id: 80069, name: "Berachain", symbol: "BERA", logoUrl: "https://tokens.debridge.finance/Logo/80069/native/big/token-logo.png", color: "#000000", explorerTxUrl: "https://berascan.com/tx" },
  { id: 80094, name: "Berachain", symbol: "BERA", logoUrl: "https://tokens.debridge.finance/Logo/80094/native/big/token-logo.png", color: "#000000", explorerTxUrl: "https://berascan.com/tx" },
  { id: 8329, name: "Story", symbol: "IP", logoUrl: "https://tokens.debridge.finance/Logo/8329/native/big/token-logo.png", color: "#FF6B35", explorerTxUrl: "https://storyscan.xyz/tx" },
  { id: 98867, name: "Plume", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/98867/native/big/token-logo.png", color: "#FF4D00", explorerTxUrl: "https://explorer.plumenetwork.xyz/tx" },
  { id: 42161, name: "Arbitrum", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/42161/native/big/token-logo.png", color: "#28A0F0", explorerTxUrl: "https://arbiscan.io/tx" },
  { id: 43114, name: "Avalanche", symbol: "AVAX", logoUrl: "https://tokens.debridge.finance/Logo/43114/native/big/token-logo.png", color: "#E84142", explorerTxUrl: "https://snowtrace.io/tx" },
  { id: 245022934, name: "Neon", symbol: "NEON", logoUrl: "https://tokens.debridge.finance/Logo/245022934/native/big/token-logo.png", color: "#00E5FF", explorerTxUrl: "https://neonscan.org/tx" },
  { id: 10143, name: "Monad", symbol: "MON", logoUrl: "https://tokens.debridge.finance/Logo/10143/native/big/token-logo.png", color: "#836EF9", explorerTxUrl: "https://explorer.monad.xyz/tx" },
  { id: 42355, name: "MegaETH", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/42355/native/big/token-logo.png", color: "#2B2B2B", explorerTxUrl: "https://explorer.megaeth.com/tx" },
  { id: 146, name: "Sonic", symbol: "S", logoUrl: "https://tokens.debridge.finance/Logo/146/native/big/token-logo.png", color: "#FFE000", explorerTxUrl: "https://sonicscan.org/tx" },
  { id: 274, name: "Abstract", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/274/native/big/token-logo.png", color: "#000000", explorerTxUrl: "https://abscan.org/tx" },
  { id: 93, name: "Sophon", symbol: "ETH", logoUrl: "https://tokens.debridge.finance/Logo/93/native/big/token-logo.png", color: "#000000", explorerTxUrl: "https://explorer.sophon.xyz/tx" },
  { id: 998, name: "HyperEVM", symbol: "HYPE", logoUrl: "https://tokens.debridge.finance/Logo/998/native/big/token-logo.png", color: "#00D1FF", explorerTxUrl: "https://explorer.hyperevm.xyz/tx" },
  { id: 25, name: "Cronos", symbol: "CRO", logoUrl: "https://tokens.debridge.finance/Logo/25/native/big/token-logo.png", color: "#002D74", explorerTxUrl: "https://cronoscan.com/tx" },
  { id: 383, name: "Cronos zkEVM", symbol: "CRO", logoUrl: "https://tokens.debridge.finance/Logo/383/native/big/token-logo.png", color: "#002D74", explorerTxUrl: "https://explorer.cronos.org/tx" },
];

const chainMap = new Map<number, ChainInfo>();
for (const chain of SUPPORTED_CHAINS) {
  chainMap.set(chain.id, chain);
}

export const chainById = chainMap;

export function getChainName(id: number): string {
  return chainMap.get(id)?.name ?? `Chain ${id}`;
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const chain = chainMap.get(chainId);
  if (!chain) return "#";
  return `${chain.explorerTxUrl}/${txHash}`;
}

export function getExplorerAddressUrl(chainId: number, address: string): string {
  const chain = chainMap.get(chainId);
  if (!chain) return "";
  const base = chain.explorerTxUrl.replace(/\/tx$/, "");
  return `${base}/address/${address}`;
}

export function getChainColor(id: number): string {
  return chainMap.get(id)?.color ?? "#6B7280";
}
