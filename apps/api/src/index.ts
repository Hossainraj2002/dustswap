import express from 'express';
import cors    from 'cors';
import helmet  from 'helmet';
import dotenv  from 'dotenv';

dotenv.config();

import { tokenRoutes  } from './routes/tokens';
import { pointsRoutes } from './routes/points';
import { healthRoutes } from './routes/health';

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://dustsweep.xyz',
    'https://www.dustsweep.xyz',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/health', healthRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/points', pointsRoutes);

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🧹 DustSweep API  →  http://localhost:${PORT}`);
  console.log(`   Health check  →  http://localhost:${PORT}/api/health\n`);
});

export default app;
