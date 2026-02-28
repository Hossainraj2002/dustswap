import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  CHECK_IN:                  50,
  SWAP:                      50,
  SWEEP_PER_TOKEN:           50,
  BRIDGE_PER_TOKEN:          50,
  BURN_PER_TOKEN:            50,

  SWEEP_MULTIPLIER:          5,
  BRIDGE_MULTIPLIER:        10,
  BURN_MULTIPLIER:           2,

  STREAK_7:                500,
  STREAK_30:             5_000,
  STREAK_90:            20_000,

  CAP_SWAP:                500,
  CAP_SWEEP:             5_000,
  CAP_BRIDGE:           10_000,
  CAP_BURN:              2_000,

  REFERRAL_SIGNUP:         500,
  REFERRAL_COMMISSION_PCT:  10,

  SHARE_FARCASTER:         200,
  SHARE_TWITTER:           100,
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function genCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return 'DUST-' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function isToday(d: string | null): boolean {
  if (!d) return false;
  return new Date(d).toDateString() === new Date().toDateString();
}

function isYesterday(d: string | null): boolean {
  if (!d) return false;
  const y = new Date(); y.setDate(y.getDate() - 1);
  return new Date(d).toDateString() === y.toDateString();
}

// ─── Engine ───────────────────────────────────────────────────────────────────
export class PointsEngine {

  async getOrCreate(address: string) {
    const norm = address.toLowerCase();
    const { data } = await supabase.from('users').select('*').eq('address', norm).single();
    if (data) return data;

    const { data: nu, error } = await supabase
      .from('users')
      .insert({ address: norm, referral_code: genCode(), total_points: 0, current_streak: 0, longest_streak: 0 })
      .select().single();
    if (error) throw new Error(`Create user: ${error.message}`);
    return nu;
  }

  private async addPoints(address: string, pts: number, action: string, txHash?: string, meta?: unknown) {
    const user = await this.getOrCreate(address);
    await supabase.from('point_events').insert({
      user_id: user.id, action, points: pts, multiplier: 1, total_awarded: pts, tx_hash: txHash, metadata: meta, season: 1,
    });
    await supabase.from('users').update({ total_points: user.total_points + pts, updated_at: new Date().toISOString() }).eq('id', user.id);
  }

  private async todayPoints(address: string, action: string): Promise<number> {
    const user  = await this.getOrCreate(address);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const { data } = await supabase.from('point_events')
      .select('total_awarded').eq('user_id', user.id).eq('action', action).gte('created_at', start.toISOString());
    return (data ?? []).reduce((s: number, r: { total_awarded: number }) => s + r.total_awarded, 0);
  }

  // ── Public actions ─────────────────────────────────────────────────────────

  async dailyCheckIn(address: string): Promise<{ points: number; streak: number }> {
    const user = await this.getOrCreate(address);
    if (isToday(user.last_check_in)) throw new Error('Already checked in today');

    const streak = isYesterday(user.last_check_in) ? user.current_streak + 1 : 1;
    let pts = CFG.CHECK_IN;
    if (streak === 7)  pts += CFG.STREAK_7;
    if (streak === 30) pts += CFG.STREAK_30;
    if (streak === 90) pts += CFG.STREAK_90;

    await supabase.from('check_ins').insert({
      user_id: user.id, check_in_date: new Date().toISOString().split('T')[0], points_earned: pts, streak_day: streak,
    });
    const longest = Math.max(streak, user.longest_streak);
    await supabase.from('users').update({
      current_streak: streak, longest_streak: longest,
      last_check_in: new Date().toISOString(), total_points: user.total_points + pts,
    }).eq('id', user.id);

    return { points: pts, streak };
  }

  async recordSweep(address: string, txHash: string, tokenCount: number, volumeUsd: number): Promise<number> {
    const base   = tokenCount * CFG.SWEEP_PER_TOKEN * CFG.SWEEP_MULTIPLIER;
    const today  = await this.todayPoints(address, 'dust_sweep');
    const capped = Math.max(0, Math.min(base, CFG.CAP_SWEEP - today));
    if (capped <= 0) return 0;

    await this.addPoints(address, capped, 'dust_sweep', txHash, { tokenCount, volumeUsd });

    // Referral commission
    const user = await this.getOrCreate(address);
    if (user.referred_by) {
      const { data: ref } = await supabase.from('users').select('address').eq('id', user.referred_by).single();
      if (ref) await this.addPoints(ref.address, Math.floor(capped * CFG.REFERRAL_COMMISSION_PCT / 100), 'referral_commission', txHash);
    }
    return capped;
  }

  async recordBridge(address: string, txHash: string, tokenCount: number, sourceChain: number, volumeUsd: number): Promise<number> {
    const base   = tokenCount * CFG.BRIDGE_PER_TOKEN * CFG.BRIDGE_MULTIPLIER;
    const today  = await this.todayPoints(address, 'dust_bridge');
    const capped = Math.max(0, Math.min(base, CFG.CAP_BRIDGE - today));
    if (capped <= 0) return 0;
    await this.addPoints(address, capped, 'dust_bridge', txHash, { tokenCount, sourceChain, volumeUsd });
    return capped;
  }

  async recordBurn(address: string, txHash: string, tokenCount: number): Promise<number> {
    const base   = tokenCount * CFG.BURN_PER_TOKEN * CFG.BURN_MULTIPLIER;
    const today  = await this.todayPoints(address, 'token_burn');
    const capped = Math.max(0, Math.min(base, CFG.CAP_BURN - today));
    if (capped <= 0) return 0;
    await this.addPoints(address, capped, 'token_burn', txHash, { tokenCount });
    return capped;
  }

  async recordSwap(address: string, txHash: string): Promise<number> {
    const today  = await this.todayPoints(address, 'swap');
    const capped = Math.max(0, Math.min(CFG.SWAP, CFG.CAP_SWAP - today));
    if (capped <= 0) return 0;
    await this.addPoints(address, capped, 'swap', txHash);
    return capped;
  }

  async getBalance(address: string) {
    const user = await this.getOrCreate(address);
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).gt('total_points', user.total_points);
    return {
      totalPoints:   user.total_points,
      rank:          (count ?? 0) + 1,
      streak:        user.current_streak,
      longestStreak: user.longest_streak,
      referralCode:  user.referral_code,
    };
  }

  async getLeaderboard(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const { data } = await supabase.from('users').select('address,total_points,current_streak')
      .order('total_points', { ascending: false }).range(offset, offset + limit - 1);
    return (data ?? []).map((u: { address: string; total_points: number; current_streak: number }, i: number) => ({
      rank: offset + i + 1,
      address: u.address,
      points: u.total_points,
      streak: u.current_streak,
    }));
  }

  async applyReferral(userAddress: string, code: string): Promise<void> {
    const user = await this.getOrCreate(userAddress);
    if (user.referred_by) throw new Error('Already referred');

    const { data: referrer } = await supabase.from('users').select('*').eq('referral_code', code).single();
    if (!referrer) throw new Error('Invalid referral code');
    if (referrer.address === userAddress.toLowerCase()) throw new Error('Cannot self-refer');

    await supabase.from('users').update({ referred_by: referrer.id }).eq('id', user.id);
    await supabase.from('referrals').insert({ referrer_id: referrer.id, referee_id: user.id });

    await this.addPoints(userAddress,     CFG.REFERRAL_SIGNUP, 'referral_welcome');
    await this.addPoints(referrer.address, CFG.REFERRAL_SIGNUP, 'referral_new_user');
  }
}

export const pointsEngine = new PointsEngine();
