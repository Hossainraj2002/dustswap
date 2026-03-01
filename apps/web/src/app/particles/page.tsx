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
}

export default function ParticlesPage() {
  const { address } = useAccount();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  const fetchBalance = useCallback(async () => {
    if (!address) return;
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/points/${address}`);
    const data = await res.json();
    if (data.success) setBalance(data.balance);
  }, [address]);

  const fetchLeaderboard = useCallback(async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/leaderboard`);
    const data = await res.json();
    if (data.success) setLeaderboard(data.leaderboard);
  }, []);

  useEffect(() => {
    fetchBalance();
    fetchLeaderboard();
  }, [fetchBalance, fetchLeaderboard]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <h1 className="text-3xl font-bold mb-4">Dust Particles Leaderboard</h1>
      {balance ? (
        <div className="max-w-md mx-auto p-6 bg-gray-900 border border-gray-800 rounded-xl mb-8">
          <h3 className="font-semibold mb-2">Your Balance</h3>
          <p>Total Points: {balance.totalPoints}</p>
          <p>Rank: {balance.rank}</p>
          <p>Current Streak: {balance.streak}</p>
          <p>Longest Streak: {balance.longestStreak}</p>
          <p>Your Referral Code: {balance.referralCode}</p>
        </div>
      ) : (
        <p className="text-center text-gray-400">Connect your wallet to view your balance.</p>
      )}
      <h2 className="text-2xl font-semibold mb-4">Top Earners</h2>
      <ol className="max-w-md mx-auto space-y-2 list-decimal list-inside text-gray-300">
        {leaderboard.map((entry) => (
          <li key={entry.address}>
            #{entry.rank} – {entry.address} – {entry.points} points
          </li>
        ))}
      </ol>

      {/* $DUST TGE info */}
      <div className="mt-8 bg-gray-900 border border-gray-800 rounded-xl p-6">
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