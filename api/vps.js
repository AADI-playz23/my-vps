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

    const isBanned = await queryD1('SELECT id FROM bans WHERE username = ? AND service = ?', [user.username, 'vps']);
    if (isBanned.length > 0) {
      return res.status(403).json({ status: 'error', msg: 'Your account has been permanently banned from the VPS service for policy violations.' });
    }

    const lockedUntil = parseInt(user.locked_until || 0);
    if (lockedUntil > Math.floor(Date.now() / 1000)) {
      return res.status(403).json({ status: 'locked', msg: 'Your account is temporarily locked for 24 hours.' });
    }

    const action = req.query.action || req.body?.action || '';
    const plans = getPlans();

    if (action === 'launch') {
      const sessionId = req.body.session_id;
      if (!sessionId) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });
      // Input sanitization: validate session_id format before touching Redis/D1
      if (typeof sessionId !== 'string' || !/^[\w-]{5,72}$/.test(sessionId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid session_id format' });
      }

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

      // ── BUG FIX 1: Write session to Redis FIRST so the runner finds it ──
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

      // ── BUG FIX 2: Count live runners via heartbeat (correct logic) ──────
      const runnerIds = await redisCmd(['SMEMBERS', 'active_runners']) || [];
      let activeRunners = 0;
      for (const runnerId of runnerIds) {
        const heartbeat = await redisCmd(['EXISTS', `heartbeat:${runnerId}`]);
        if (heartbeat === 1) activeRunners++;
      }

      // ── BUG FIX 3: Always trigger if below hard cap of 3 runners ─────────
      let triggered = false;
      const host = req.headers.host || '';
      const apiProtocol = host.includes('localhost') ? 'http' : 'https';
      const api_url = `${apiProtocol}://${host}`;
      console.log(`[Trigger] Active runners: ${activeRunners}/3 | GH_OWNER=${process.env.GH_OWNER} GH_REPO=${process.env.GH_REPO} GH_TOKEN_SET=${!!process.env.GH_TOKEN}`);

      if (activeRunners < 3) {
        triggered = await triggerRunner(
          { event_type: 'run-shared', client_payload: { runner_number: activeRunners + 1, api_url } },
          process.env
        );
        console.log(`[Trigger] runner_triggered=${triggered}`);
      } else {
        console.log('[Trigger] Max runners (3) already active — relying on queue processor');
      }

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
      if (typeof sessionId !== 'string' || !/^[\w-]{5,72}$/.test(sessionId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid session_id format' });
      }

      const redisRes = await redisCmd(['GET', `session:${sessionId}`]);
      if (redisRes) {
        try {
          const sData = JSON.parse(redisRes);
          if (sData.status === 'active' && sData.tunnel_url) {
            return res.status(200).json({ status: 'active', tunnel_url: sData.tunnel_url, plan: user.plan });
          } else if (sData.status === 'queued') {
            // Return queue position so the frontend can display it
            const queuePos = await redisCmd(['ZRANK', 'vps_queue', sessionId]);
            return res.status(200).json({
              status: 'queued',
              plan: user.plan,
              queue_position: queuePos !== null ? queuePos + 1 : '?'
            });
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

/**
 * Trigger a GitHub Actions workflow dispatch with automatic retry.
 *
 * BUG FIX 4: retries=2 meant only 1 real attempt (loop: i=0,1 → break on success).
 *   Changed default to 3 so we get 3 real attempts.
 * BUG FIX 5: now logs the full GitHub API response body so you can see
 *   WHY it failed (401=bad token, 404=wrong owner/repo, 422=wrong event_type).
 */
async function triggerRunner(payload, env, retries = 3) {
  const { GH_TOKEN, GH_OWNER, GH_REPO } = env;

  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) {
    console.error(`[Dispatch] MISSING env vars — GH_TOKEN=${!!GH_TOKEN} GH_OWNER=${GH_OWNER} GH_REPO=${GH_REPO}`);
    return false;
  }

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`;
  console.log(`[Dispatch] POST ${url} | event_type=${payload.event_type}`);

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `token ${GH_TOKEN}`,
          'User-Agent': 'AbsoraCloud-Vercel',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        console.log(`[Dispatch] Success on attempt ${i + 1} (HTTP ${res.status})`);
        return true;
      }

      // BUG FIX 5: log the actual GitHub error body
      const body = await res.text();
      console.error(`[Dispatch] Attempt ${i + 1} failed — HTTP ${res.status}: ${body}`);

      // 401 or 404 are fatal — no point retrying
      if (res.status === 401 || res.status === 404) {
        console.error('[Dispatch] Fatal error — aborting retries');
        return false;
      }
    } catch (e) {
      console.error(`[Dispatch] Attempt ${i + 1} exception: ${e.message}`);
    }

    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return false;
}
