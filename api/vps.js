import { queryD1, executeD1 } from './_lib/d1.js';
import { getPlans } from './_lib/plans.js';
import { redisCmd, redisParseHash } from './_lib/redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ status: 'error', msg: 'Not logged in' });

  try {
    const tokens = await queryD1('SELECT * FROM auth_tokens WHERE token = ? AND expires_at > datetime("now")', [token]);
    if (tokens.length === 0) return res.status(401).json({ status: 'error', msg: 'Invalid or expired token' });
    const userId = tokens[0].user_id;

    const users = await queryD1('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];
    if (!user) return res.status(404).json({ status: 'error', msg: 'User not found' });

    const action = req.query.action || req.body?.action || '';
    const plans = getPlans();

    if (action === 'launch') {
      const sessionId = req.body.session_id;
      if (!sessionId) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });

      const planKey = user.plan;
      const plan = plans[planKey];
      const needCpu = plan.cpu_cores;
      const needRam = plan.ram_mb;

      await executeD1("UPDATE vps_sessions SET status='expired' WHERE user_id=? AND expires_at <= datetime('now') AND status != 'expired'", [userId]);

      const activeCountRes = await queryD1("SELECT COUNT(*) as cnt FROM vps_sessions WHERE user_id=? AND status IN ('active','pending') AND expires_at > datetime('now')", [userId]);
      const activeCount = activeCountRes[0].cnt;

      if (activeCount >= plan.slots) {
        return res.status(400).json({ status: 'error', msg: `You are already running ${activeCount}/${plan.slots} VPS slots. Terminate one to launch another.` });
      }

      const sessionExists = await queryD1("SELECT id FROM vps_sessions WHERE session_key=? AND status IN ('active','pending') AND expires_at > datetime('now')", [sessionId]);
      if (sessionExists.length > 0) {
        return res.status(400).json({ status: 'error', msg: 'This session slot is already running.' });
      }

      const sessionSecs = plan.session_secs;
      const expiresAtDate = new Date(Date.now() + sessionSecs * 1000);
      const expiresAt = expiresAtDate.toISOString().slice(0, 19).replace('T', ' ');

      await executeD1("INSERT INTO vps_sessions (user_id, session_key, status, expires_at) VALUES (?,?,'pending',?)", [userId, sessionId, expiresAt]);

      // Since the actual Upstash matching logic is complex, we queue them here for demonstration,
      // or directly use redisCmd to queue.
      // Find active runners
      const runnerKeys = await redisCmd(['KEYS', 'runner:*']) || [];
      let activeRunners = 0;
      for (const key of runnerKeys) {
        const runnerId = key.replace('runner:', '');
        const heartbeat = await redisCmd(['EXISTS', `heartbeat:${runnerId}`]);
        if (heartbeat === 1) activeRunners++;
      }

      let triggered = false;
      if (activeRunners < 3) {
        const payload = {
          event_type: "run-shared",
          client_payload: { runner_number: activeRunners + 1 }
        };
        const { GH_TOKEN, GH_OWNER, GH_REPO } = process.env;
        const githubRes = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            "Authorization": `token ${GH_TOKEN}`,
            "User-Agent": "AbsoraCloud-Vercel",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        triggered = githubRes.ok;
      }

      // The triggered variable is already declared above

      const sessionData = {
        status: 'queued',
        user_id: userId,
        plan: planKey,
        expires_at: Math.floor(expiresAtDate.getTime() / 1000)
      };
      await redisCmd(['SET', `session:${sessionId}`, JSON.stringify(sessionData), 'EX', (sessionSecs + 300).toString()]);

      const priorities = { 'free': 100, 'basic': 200, 'pro': 300, 'enterprise': 400 };
      const score = priorities[planKey] || 100;
      await redisCmd(['ZADD', 'vps_queue', score.toString(), sessionId]);
      
      return res.status(200).json({
        status: 'queued',
        plan: planKey,
        plan_info: plan,
        expires: expiresAt,
        runner_triggered: triggered
      });
    }

    if (action === 'check_session') {
      const sessionId = req.query.session_id;
      if (!sessionId) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });

      const redisRes = await redisCmd(['GET', `session:${sessionId}`]);
      if (redisRes) {
        try {
          const sData = JSON.parse(redisRes);
          if (sData.status === 'active' && sData.tunnel_url) {
            // Sync active status to D1 optionally, but return to frontend immediately
            return res.status(200).json({ status: 'active', tunnel_url: sData.tunnel_url, plan: user.plan });
          } else if (sData.status === 'queued') {
            return res.status(200).json({ status: 'queued', plan: user.plan });
          }
        } catch(e){}
      }

      const sessions = await queryD1('SELECT * FROM vps_sessions WHERE session_key = ?', [sessionId]);
      if (sessions.length === 0) return res.status(404).json({ status: 'error', msg: 'Session not found' });
      const session = sessions[0];
      
      if (session.user_id !== userId) return res.status(401).json({ status: 'error', msg: 'Unauthorized' });

      return res.status(200).json({
        status: session.status,
        tunnel_url: session.tunnel_url,
        plan: user.plan
      });
    }

    if (action === 'kill_session') {
      const sessionId = req.body.session_id;
      if (!sessionId) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });
      
      await executeD1("UPDATE vps_sessions SET status='expired' WHERE session_key=? AND user_id=?", [sessionId, userId]);
      // Remove from redis
      await redisCmd(['DEL', `session:${sessionId}`]);

      return res.status(200).json({ status: 'success', msg: 'Session terminated' });
    }

    return res.status(400).json({ status: 'error', msg: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', msg: err.message });
  }
}
