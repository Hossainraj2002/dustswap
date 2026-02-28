'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';

interface Balance {
  totalPoints:   number;
  rank:          number;
  streak:        number;
  longestStreak: number;
  referralCode:  string;
}

interface LeaderboardEntry {
  rank:    number;
  address: string;
  points:  number;
  streak:  number;
}

const EARN_ROWS = [
  { icon: '✅', action: 'Daily check-in',           pts: '50'     },
  { icon: '🔄', action: 'Normal swap',               pts: '50'     },
  { icon: '🧹', action: 'Dust sweep (per token)',    pts: '250 (5×)' },
  { icon: '🌉', action: 'Dust bridge (per token)',   pts: '500 (10×)' },
  { icon: '🔥', action: 'Burn tokens (per token)',   pts: '100 (2×)' },
  { icon: '👥', action: 'Refer a friend',            pts: '500 + 10%' },
  { icon: '🔥', action: '7-day streak bonus',        pts: '500'    },
  { icon: '🔥', action: '30-day streak bonus',       pts: '5,000'  },
  { icon: '🔥', action: '90-day streak bonus',       pts: '20,000' },
];

export default function ParticlesPage() {
  const { address, isConnected } = useAccount();

  const [balance,       setBalance]       = useState<Balance | null>(null);
  const [leaderboard,   setLeaderboard]   = useState<LeaderboardEntry[]>([]);
  const [checkingIn,    setCheckingIn]    = useState(false);
  const [checkedToday,  setCheckedToday]  = useState(false);
  const [copied,        setCopied]        = useState(false);

  const API = process.env.NEXT_PUBLIC_API_URL;

  const fetchBalance = useCallback(async () => {
    if (!address) return;
    const r = await fetch(`${API}/api/points/balance/${address}`);
    const d = await r.json();
    if (d.success) setBalance(d);
  }, [address, API]);

  const fetchLeaderboard = useCallback(async () => {
    const r = await fetch(`${API}/api/points/leaderboard?limit=10`);
    const d = await r.json();
    if (d.success) setLeaderboard(d.data);
  }, [API]);

  useEffect(() => {
    if (address) { fetchBalance(); fetchLeaderboard(); }
  }, [address, fetchBalance, fetchLeaderboard]);

  async function handleCheckIn() {
    if (!address) return;
    setCheckingIn(true);
    try {
      const r = await fetch(`${API}/api/points/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const d = await r.json();
      if (d.success) {
        setCheckedToday(true);
        fetchBalance();
        fetchLeaderboard();
      }
    } finally {
      setCheckingIn(false);
    }
  }

  function copyReferral() {
    if (!balance?.referralCode) return;
    navigator.clipboard.writeText(`https://dustsweep.xyz?ref=${balance.referralCode}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="text-6xl mb-4">✨</div>
        <h1 className="text-3xl font-bold mb-3">Dust Particles</h1>
        <p className="text-gray-400">Connect your wallet to view and earn points</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">✨ Dust Particles</h1>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Your Balance',  value: (balance?.totalPoints ?? 0).toLocaleString(), unit: 'Particles', color: 'text-yellow-400' },
          { label: 'Global Rank',   value: `#${balance?.rank ?? '—'}`,                   unit: '',          color: '' },
          { label: 'Streak',        value: `${balance?.streak ?? 0} 🔥`,                 unit: 'days',      color: 'text-orange-400' },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <p className="text-gray-400 text-sm mb-1">{s.label}</p>
            <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
            {s.unit && <p className="text-xs text-gray-500 mt-1">{s.unit}</p>}
          </div>
        ))}
      </div>

      {/* Check-in */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Daily Check-In</h3>
          <p className="text-gray-400 text-sm mt-1">Check in daily to earn points and build streaks</p>
        </div>
        <button
          onClick={handleCheckIn}
          disabled={checkingIn || checkedToday}
          className={`px-5 py-2.5 rounded-lg font-medium text-sm transition-colors ${
            checkedToday
              ? 'bg-green-700 text-white cursor-default'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          } disabled:opacity-60`}
        >
          {checkedToday ? '✅ Checked In' : checkingIn ? 'Checking…' : '✅ Check In (+50)'}
        </button>
      </div>

      {/* Referral */}
      {balance?.referralCode && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
          <h3 className="font-semibold mb-2">👥 Referral Code</h3>
          <p className="text-gray-400 text-sm mb-3">Share your link. You earn 500 pts per sign-up + 10% of their ongoing points.</p>
          <div className="flex gap-2">
            <code className="flex-1 bg-gray-800 rounded-lg px-3 py-2 text-sm font-mono text-blue-300">
              dustsweep.xyz?ref={balance.referralCode}
            </code>
            <button
              onClick={copyReferral}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
            >
              {copied ? '✅' : '📋 Copy'}
            </button>
          </div>
        </div>
      )}

      {/* How to earn */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold mb-4">How to Earn Particles</h3>
        <div className="space-y-0">
          {EARN_ROWS.map(r => (
            <div key={r.action} className="flex items-center justify-between py-2.5 border-b border-gray-800 last:border-0 text-sm">
              <span className="flex items-center gap-2 text-gray-300">
                <span>{r.icon}</span>{r.action}
              </span>
              <span className="text-yellow-400 font-medium">+{r.pts}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold mb-4">🏆 Top 10</h3>
        <div className="space-y-2">
          {leaderboard.length === 0 ? (
            <p className="text-gray-500 text-center py-4">No data yet. Be first!</p>
          ) : leaderboard.map((e, i) => (
            <div
              key={e.address}
              className={`flex items-center justify-between p-3 rounded-lg text-sm ${
                e.address === address?.toLowerCase()
                  ? 'bg-blue-900/30 border border-blue-700'
                  : 'bg-gray-800/50'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="w-7 text-center font-bold">
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${e.rank}`}
                </span>
                <span className="font-mono text-gray-300">
                  {e.address.slice(0, 6)}…{e.address.slice(-4)}
                </span>
              </div>
              <span className="font-semibold text-yellow-400">{e.points.toLocaleString()} pts</span>
            </div>
          ))}
        </div>
      </div>

      {/* $DUST TGE info */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="font-semibold mb-2">$DUST Token</h3>
        <p className="text-gray-400 text-sm">
          Dust Particles convert to $DUST tokens at TGE. The more particles you hold, the larger your $DUST allocation.
          Keep sweeping!
        </p>
        <p className="text-gray-500 text-xs mt-2">⏳ Estimated TGE: Q4 2025</p>
      </div>
    </div>
  );
}
