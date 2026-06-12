import { redisCmd } from './_lib/redis.js';
import { queryD1 } from './_lib/d1.js';

/**
 * GET /api/health
 * 
 * Health check endpoint that verifies Redis and D1 connectivity.
 * Returns HTTP 200 when all systems are healthy, 503 when degraded.
 * Can be used by Vercel monitoring or external uptime checkers.
 */
export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', msg: 'Method not allowed' });
  }

  const checks = {};

  // Check Redis (Upstash)
  try {
    const pong = await redisCmd(['PING']);
    checks.redis = pong === 'PONG';
  } catch (e) {
    checks.redis = false;
    checks.redis_error = e.message;
  }

  // Check D1 (Cloudflare)
  try {
    await queryD1('SELECT 1');
    checks.d1 = true;
  } catch (e) {
    checks.d1 = false;
    checks.d1_error = e.message;
  }

  // Runner stats from Redis
  try {
    const runnerIds = await redisCmd(['SMEMBERS', 'active_runners']) || [];
    checks.active_runners = runnerIds.length;
    const queueLen = await redisCmd(['ZCARD', 'vps_queue']);
    checks.queue_depth = queueLen || 0;
  } catch (e) {
    checks.active_runners = null;
    checks.queue_depth = null;
  }

  const allOk = checks.redis && checks.d1;
  const httpStatus = allOk ? 200 : 503;

  return res.status(httpStatus).json({
    status: allOk ? 'ok' : 'degraded',
    ts: new Date().toISOString(),
    ...checks,
  });
}
