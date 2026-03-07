'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAccount, useReadContract, useBalance } from 'wagmi';
import { parseUnits, encodeFunctionData, erc20Abi } from 'viem';

import {
  Transaction,
  TransactionButton,
  TransactionStatus,
  TransactionStatusAction,
  TransactionStatusLabel,
} from '@coinbase/onchainkit/transaction';
import { ConnectWallet, Wallet } from '@coinbase/onchainkit/wallet';

// --- Types ---
type NeynarProfile = {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string;
};

type UserStats = {
  totalPoints: number;
  dustSwept: number;
  swapVolume: number;
  tokensBurned: number;
};

type ReferralStats = {
  code: string;
  friendsJoined: number;
  pointsEarned: number;
};

type LeaderboardRow = {
  rank: number;
  address: string;
  points: number;
  streak: number;
};

// --- Constants ---
const CHECK_IN_TARGET_ADDRESS = '0xe641fB39Fd807B536f37F9268938D67587302E5d';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// 0.01 USDC (6 decimals)
const USDC_AMOUNT = 10000n; 
// 0.01 USD worth of ETH (~ 0.000003 ETH at $3300/ETH)
const ETH_AMOUNT = parseUnits('0.000003', 18);

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// --- Helper Make shortened address ---
function shortAddress(address: string) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function ProfilePage() {
  const { address, isConnected } = useAccount();
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [referral, setReferral] = useState<ReferralStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  
  const [streak, setStreak] = useState(0);
  const [isCopied, setIsCopied] = useState(false);
  const [checkInDone, setCheckInDone] = useState(false);
  
  // Wallet Balances for CheckIn Choice
  const { data: usdcBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
  });

  const fetchProfileData = useCallback(async () => {
    if (!address) return;

    try {
      // Fetch Neynar
      fetch(`/api/neynar/user?address=${address}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && !data.error) setProfile(data);
        })
        .catch(console.error);

      // Fetch Stats
      fetch(`${API_URL}/api/points/${address}/stats`)
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
             setStats({
               totalPoints: data.totalPoints,
               dustSwept: data.dustSwept,
               swapVolume: data.swapVolume,
               tokensBurned: data.tokensBurned,
             });
          }
        })
        .catch(console.error);

      // Fetch points info for streak
      fetch(`${API_URL}/api/points/${address}`)
        .then((res) => res.json())
        .then((data) => {
           if (data.success) {
             setStreak(data.streak || 0);
           }
        })
        .catch(console.error);

      // Fetch Referrals
      fetch(`${API_URL}/api/points/${address}/referrals`)
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            setReferral({
              code: data.code,
              friendsJoined: data.friendsJoined,
              pointsEarned: data.pointsEarned,
            });
          }
        })
        .catch(console.error);

      // Fetch Leaderboard
      fetch(`${API_URL}/api/points/leaderboard?limit=50`)
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            setLeaderboard(data.data);
          }
        })
        .catch(console.error);

    } catch (error) {
       console.error("Failed to load profile data", error);
    }
  }, [address]);

  useEffect(() => {
    if (isConnected) {
      fetchProfileData();
    }
  }, [isConnected, fetchProfileData]);


  // Check-In Tx Generation
  const hasUSDC = (usdcBalance?.value || 0n) >= USDC_AMOUNT;

  const checkInCalls = useMemo(() => {
    if (!address) return [];
    
    // Fallback: Use ETH if no USDC
    if (!hasUSDC) {
       return [{
         to: CHECK_IN_TARGET_ADDRESS as `0x${string}`,
         value: ETH_AMOUNT,
         data: '0x' as `0x${string}`,
       }];
    }

    // Default: Use USDC
    return [{
       to: USDC_ADDRESS as `0x${string}`,
       data: encodeFunctionData({
         abi: erc20Abi,
         functionName: 'transfer',
         args: [CHECK_IN_TARGET_ADDRESS as `0x${string}`, USDC_AMOUNT],
       })
    }];
  }, [address, hasUSDC]);

  const onCheckInSuccess = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`${API_URL}/api/points/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address })
      });
      const data = await res.json();
      if (data.success) {
         setCheckInDone(true);
         setStreak(data.streak);
         if (stats) {
            setStats(prev => prev ? { ...prev, totalPoints: prev.totalPoints + data.points } : null);
         }
      }
    } catch (err) {
      console.error("Checkin API error", err);
    }
  }, [address, stats]);


  // --- Render Unconnected / Unmounted ---
  if (!isMounted) return null;

  if (!isConnected) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-4">
        <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-8 max-w-sm w-full text-center shadow-2xl glass">
          <div className="w-16 h-16 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Connect your wallet to start your journey</h2>
          <p className="text-gray-400 text-sm mb-6">See your stats, earn points, and sweep your dust.</p>
          <div className="flex justify-center">
            <Wallet>
              <ConnectWallet />
            </Wallet>
          </div>
        </div>
      </div>
    );
  }

  // --- Render Connected ---
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6 pb-24">
      
      {/* SECTION 1: Header Bar */}
      <div className="flex items-center justify-between p-4 bg-gray-900/60 border border-gray-800 rounded-2xl glass">
        <div className="flex items-center gap-4">
          {profile?.pfp_url ? (
            <img src={profile.pfp_url} alt="Profile" className="w-14 h-14 rounded-full border-2 border-purple-500/50" />
          ) : (
            <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center border-2 border-purple-400/50">
              <span className="text-white text-xl font-bold">{address?.slice(2, 4)}</span>
            </div>
          )}
          
          <div>
            <h2 className="text-xl font-bold text-white">
              {profile?.display_name || profile?.username || shortAddress(address || '')}
            </h2>
            {profile && <p className="text-purple-400 text-sm">@{profile.username}</p>}
          </div>
        </div>

        <div className="bg-purple-900/30 border border-purple-500/30 px-5 py-2.5 rounded-xl shadow-[0_0_15px_rgba(168,85,247,0.2)]">
          <p className="text-purple-300 text-xs font-semibold uppercase tracking-wider mb-0.5">Particle Points</p>
          <p className="text-2xl font-bold text-white tracking-tight">⚡ {(stats?.totalPoints || 0).toLocaleString()}</p>
        </div>
      </div>

      {/* SECTION 2: Daily Check-In Banner */}
      {!checkInDone && (
        <div className="h-16 w-full rounded-2xl bg-gradient-to-r from-blue-900/40 to-purple-900/40 border border-indigo-500/30 overflow-hidden flex shadow-lg shadow-indigo-500/10">
          <div className="flex-1 flex items-center px-6">
             <span className="text-2xl mr-3 opacity-90">🔥</span>
             <div>
                <p className="text-white font-semibold text-sm">Daily Check-In</p>
                <p className="text-indigo-300 text-xs">Day {streak + 1} of 30 • Earn 500 pts</p>
             </div>
          </div>
          
          <div className="flex items-center px-3" onClick={(e) => e.stopPropagation()}>
             <Transaction
                chainId={8453}
                calls={checkInCalls as any}
                capabilities={{
                  paymasterService: { url: process.env.NEXT_PUBLIC_PAYMASTER_URL! },
                } as any}
                onSuccess={onCheckInSuccess}
             >
                <TransactionButton 
                   text="CHECK IN"
                   className="!bg-indigo-600 hover:!bg-indigo-500 !text-white !font-bold !text-sm !px-6 !py-2 !rounded-xl !shadow-md !shadow-indigo-500/20 w-auto min-w-[120px]"
                />
             </Transaction>
          </div>
        </div>
      )}

      {/* SECTION 3: User Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Particle Points" value={(stats?.totalPoints || 0).toLocaleString()} icon="⚡" />
        <StatCard title="Dust Swept" value={(stats?.dustSwept || 0).toLocaleString()} icon="🌪️" />
        <StatCard title="Swap Volume" value={`$${(stats?.swapVolume || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits:2})}`} icon="💱" />
        <StatCard title="Tokens Burned" value={(stats?.tokensBurned || 0).toLocaleString()} icon="🔥" />
      </div>

      {/* SECTION 4: Referral */}
      <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-6 glass">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex-1 w-full">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
              Invite Friends
            </h3>
            <p className="text-gray-400 text-sm mt-1">Both you and your friend get 500 Particle pts. You also earn 20% of their future points!</p>
            
            <div className="mt-4 flex gap-4 text-sm">
              <div className="bg-gray-800/80 px-3 py-1.5 rounded-lg border border-gray-700">
                <span className="text-gray-400">Friends Joined: </span>
                <span className="text-white font-medium">{referral?.friendsJoined || 0}</span>
              </div>
              <div className="bg-gray-800/80 px-3 py-1.5 rounded-lg border border-gray-700">
                <span className="text-gray-400">Points Earned: </span>
                <span className="text-white font-medium">⚡ {(referral?.pointsEarned || 0).toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="w-full md:w-auto">
             <div className="bg-gray-950 border border-gray-700 rounded-xl flex items-center overflow-hidden">
                <div className="px-4 py-2.5 text-blue-400 font-mono font-medium tracking-wider flex-1 text-center">
                   {referral?.code || 'LOADING...'}
                </div>
                <button 
                  onClick={() => {
                     if (referral?.code) {
                        navigator.clipboard.writeText(`https://dustswap.app/ref/${referral.code}`);
                        setIsCopied(true);
                        setTimeout(() => setIsCopied(false), 2000);
                     }
                  }}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 font-medium transition-colors border-l border-gray-700"
                >
                  {isCopied ? 'Copied!' : 'Copy Link'}
                </button>
             </div>
          </div>
        </div>
      </div>

      {/* SECTION 5: Leaderboard */}
      <div className="bg-gray-900/60 border border-gray-800 rounded-2xl overflow-hidden glass">
         <div className="p-5 flex items-center justify-between border-b border-gray-800">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
              Leaderboard
            </h3>
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Top 50</span>
         </div>
         
         <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap">
               <thead>
                  <tr className="bg-gray-950/50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                     <th className="px-6 py-3">Rank</th>
                     <th className="px-6 py-3">User</th>
                     <th className="px-6 py-3 text-right">Points</th>
                     <th className="px-6 py-3 text-right">Streak</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-gray-800/50">
                  {leaderboard.map((row) => (
                    <tr 
                      key={row.address || Math.random()} 
                      className={`${(address && row.address?.toLowerCase() === address.toLowerCase()) ? 'bg-purple-900/20' : 'hover:bg-gray-800/30'}`}
                    >
                       <td className="px-6 py-4">
                          {row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : <span className="text-gray-400 font-mono">#{row.rank}</span>}
                       </td>
                       <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                             <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-700 to-gray-800 flex items-center justify-center border border-gray-600">
                                <span className="text-gray-300 text-xs font-bold">{row.address?.slice(2,4) || '??'}</span>
                             </div>
                             {(address && row.address?.toLowerCase() === address.toLowerCase()) ? (
                                <span className="text-purple-400 font-medium">{shortAddress(row.address)} (You)</span>
                             ) : (
                                <span className="text-gray-300">{shortAddress(row.address || '')}</span>
                             )}
                          </div>
                       </td>
                       <td className="px-6 py-4 text-right">
                          <span className="text-white font-bold">⚡ {(row.points || 0).toLocaleString()}</span>
                       </td>
                       <td className="px-6 py-4 text-right">
                          <span className="text-gray-400">{row.streak || 0} 🔥</span>
                       </td>
                    </tr>
                  ))}
                  {leaderboard.length === 0 && (
                     <tr>
                        <td colSpan={4} className="px-6 py-12 text-center text-gray-500">
                           No users on the leaderboard yet.
                        </td>
                     </tr>
                  )}
               </tbody>
            </table>
         </div>
      </div>

    </div>
  );
}

// Subcomponent for Stats
function StatCard({ title, value, icon }: { title: string, value: string | undefined, icon: string }) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-5 hover:bg-gray-800/80 transition-colors glass">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl">{icon}</span>
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{title}</h4>
      </div>
      <p className="text-2xl font-bold text-white tracking-tight">
        {value === undefined ? <span className="text-gray-600 animate-pulse">...</span> : value}
      </p>
    </div>
  );
}
