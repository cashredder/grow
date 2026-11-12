import meteorIcon from '../assets/wallets/meteor.png'
import intearIcon from '../assets/wallets/intear.svg'
import hotIcon from '../assets/wallets/hot.png'
// Where the site talks to. With VITE_API_URL set the site runs on the real contracts and API (lib/live.ts);
// without it, it runs on the built-in market in lib/store.ts (for working on the design offline).
const env = import.meta.env

export const API_URL: string = (env.VITE_API_URL || '').replace(/\/+$/, '')
export const LIVE = !!API_URL
export const NETWORK: 'mainnet' | 'testnet' = env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
export const LAUNCHPAD: string = env.VITE_LAUNCHPAD || (NETWORK === 'mainnet' ? 'grow.near' : 'grow.testnet')
// MyNearWallet no longer accepts new app connections, so it is not offered.
// Logos come from the wallets' own wallet-selector packages.
export const WALLETS = [
  { id: 'hot-wallet', name: 'HOT Wallet', icon: hotIcon },
  { id: 'meteor-wallet', name: 'Meteor Wallet', icon: meteorIcon },
  { id: 'intear-wallet', name: 'Intear Wallet', icon: intearIcon },
]

export const RPC_URL: string = env.VITE_RPC_URL || (NETWORK === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org')
