import { Router } from 'express';
const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'dustsweep-api',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

export { router as healthRoutes };
