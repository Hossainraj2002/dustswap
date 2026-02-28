import { Router, Request, Response } from 'express';
import { pointsEngine } from '../services/pointsEngine';

const router = Router();

// GET /api/points/balance/:address
router.get('/balance/:address', async (req: Request, res: Response) => {
  try {
    const data = await pointsEngine.getBalance(req.params.address);
    res.json({ success: true, ...data });
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST /api/points/check-in
router.post('/check-in', async (req: Request, res: Response) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const result = await pointsEngine.dailyCheckIn(address);
    res.json({ success: true, ...result });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    res.status(msg === 'Already checked in today' ? 400 : 500).json({ success: false, error: msg });
  }
});

// POST /api/points/record-sweep
router.post('/record-sweep', async (req: Request, res: Response) => {
  const { address, txHash, tokenCount, volumeUsd } = req.body;
  if (!address || !txHash || tokenCount == null) return res.status(400).json({ error: 'Missing fields' });
  try {
    const pts = await pointsEngine.recordSweep(address, txHash, tokenCount, volumeUsd ?? 0);
    res.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST /api/points/record-bridge
router.post('/record-bridge', async (req: Request, res: Response) => {
  const { address, txHash, tokenCount, sourceChain, volumeUsd } = req.body;
  if (!address || !txHash) return res.status(400).json({ error: 'Missing fields' });
  try {
    const pts = await pointsEngine.recordBridge(address, txHash, tokenCount ?? 1, sourceChain ?? 0, volumeUsd ?? 0);
    res.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST /api/points/record-burn
router.post('/record-burn', async (req: Request, res: Response) => {
  const { address, txHash, tokenCount } = req.body;
  if (!address || !txHash) return res.status(400).json({ error: 'Missing fields' });
  try {
    const pts = await pointsEngine.recordBurn(address, txHash, tokenCount ?? 1);
    res.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST /api/points/record-swap
router.post('/record-swap', async (req: Request, res: Response) => {
  const { address, txHash } = req.body;
  if (!address || !txHash) return res.status(400).json({ error: 'Missing fields' });
  try {
    const pts = await pointsEngine.recordSwap(address, txHash);
    res.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET /api/points/leaderboard
router.get('/leaderboard', async (req: Request, res: Response) => {
  const page  = Math.max(1,   parseInt(req.query.page  as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
  try {
    const data = await pointsEngine.getLeaderboard(page, limit);
    res.json({ success: true, page, limit, data });
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST /api/points/referral/apply
router.post('/referral/apply', async (req: Request, res: Response) => {
  const { address, referralCode } = req.body;
  if (!address || !referralCode) return res.status(400).json({ error: 'address and referralCode required' });
  try {
    await pointsEngine.applyReferral(address, referralCode);
    res.json({ success: true, message: 'Referral applied!' });
  } catch (e: unknown) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

export { router as pointsRoutes };
