import bcrypt from 'bcryptjs';
import { queryD1, executeD1 } from './_lib/d1.js';
import { redisCmd } from './_lib/redis.js';

/**
 * Admin API — /api/admin
 *
 * One-time Registration Flow:
 *   POST { action: 'admin_register', username, password, setup_key }
 *   → Only succeeds if NO admin exists yet and setup_key matches env var.
 *   → Returns a signed admin token stored in Redis (24h TTL).
 *
 * Login Flow:
 *   POST { action: 'admin_login', username, password }
 *   → Verifies bcrypt password against admins table.
 *   → Returns a signed admin token stored in Redis (24h TTL).
 *
 * All other admin actions require:
 *   Header: Authorization: Bearer <admin_token>
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function generateToken() {
  // 48 random bytes → 64-char hex string
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function setAdminToken(token) {
  // Store in Redis with 24-hour TTL
  await redisCmd(['SET', `admin_token:${token}`, '1', 'EX', '86400']);
}

async function validateAdminToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return false;
  const exists = await redisCmd(['EXISTS', `admin_token:${token}`]);
  return exists === 1;
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action || '';

  try {

    // ──────────────────────────────────────────────────────────────────────
    // ONE-TIME ADMIN REGISTRATION
    // Only works when no admin account exists yet.
    // Requires a ADMIN_SETUP_KEY env var as an extra gate.
    // ──────────────────────────────────────────────────────────────────────
    if (action === 'admin_register') {
      const { username, password, setup_key } = req.body || {};

      if (!username || !password || !setup_key) {
        return res.status(400).json({ status: 'error', msg: 'username, password, and setup_key are required' });
      }

      // Gate: setup_key must match env var
      const validSetupKey = process.env.ADMIN_SETUP_KEY;
      if (!validSetupKey || setup_key !== validSetupKey) {
        return res.status(403).json({ status: 'error', msg: 'Invalid setup key' });
      }

      // Ensure no admin exists yet (one-time only)
      const existing = await queryD1('SELECT COUNT(*) as cnt FROM admins');
      if (existing[0]?.cnt > 0) {
        return res.status(409).json({ status: 'error', msg: 'Admin already registered. Use admin_login instead.' });
      }

      // Validate input
      if (username.length < 3 || username.length > 32) {
        return res.status(400).json({ status: 'error', msg: 'Username must be 3–32 characters' });
      }
      if (password.length < 8) {
        return res.status(400).json({ status: 'error', msg: 'Password must be at least 8 characters' });
      }

      const hash = await bcrypt.hash(password, 12);
      await executeD1('INSERT INTO admins (username, password) VALUES (?, ?)', [username, hash]);

      const token = generateToken();
      await setAdminToken(token);

      return res.status(200).json({
        status: 'success',
        msg: 'Admin account created. This endpoint is now locked — use admin_login for future logins.',
        token,
        username,
      });
    }

    // ──────────────────────────────────────────────────────────────────────
    // ADMIN LOGIN
    // ──────────────────────────────────────────────────────────────────────
    if (action === 'admin_login') {
      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ status: 'error', msg: 'username and password required' });
      }

      const admins = await queryD1('SELECT * FROM admins WHERE username = ?', [username]);
      if (admins.length === 0) {
        // Generic message to prevent username enumeration
        return res.status(401).json({ status: 'error', msg: 'Invalid credentials' });
      }

      const admin = admins[0];
      const match = await bcrypt.compare(password, admin.password);
      if (!match) {
        return res.status(401).json({ status: 'error', msg: 'Invalid credentials' });
      }

      const token = generateToken();
      await setAdminToken(token);

      return res.status(200).json({
        status: 'success',
        msg: 'Logged in',
        token,
        username: admin.username,
        expires_in: '24h',
      });
    }

    // ──────────────────────────────────────────────────────────────────────
    // ADMIN LOGOUT
    // ──────────────────────────────────────────────────────────────────────
    if (action === 'admin_logout') {
      const auth = req.headers.authorization || '';
      const token = auth.replace('Bearer ', '').trim();
      if (token) await redisCmd(['DEL', `admin_token:${token}`]);
      return res.status(200).json({ status: 'success', msg: 'Logged out' });
    }

    // ──────────────────────────────────────────────────────────────────────
    // PROTECTED ROUTES — require valid admin token
    // ──────────────────────────────────────────────────────────────────────
    const isAdmin = await validateAdminToken(req);
    if (!isAdmin) {
      return res.status(401).json({ status: 'error', msg: 'Unauthorized — valid admin token required' });
    }

    // ── DB Setup ──────────────────────────────────────────────────────────
    if (action === 'setup') {
      const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            plan TEXT NOT NULL DEFAULT 'free',
            tos_accepted INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            is_active INTEGER DEFAULT 1
        )`,
        `CREATE TABLE IF NOT EXISTS vps_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_key TEXT NOT NULL UNIQUE,
            tunnel_url TEXT,
            runner_id TEXT,
            runner_type TEXT NOT NULL DEFAULT 'shared',
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            status TEXT DEFAULT 'pending',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            plan TEXT NOT NULL,
            amount INTEGER NOT NULL,
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reviewed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES payments(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at DATETIME NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            runner_id TEXT,
            action TEXT NOT NULL,
            plan TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS warns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            service TEXT NOT NULL,
            reason TEXT NOT NULL,
            screenshot_proof TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      ];

      for (const sql of queries) {
        await executeD1(sql);
      }
      
      // Migration: add tos_accepted, banned, locked_until to existing table
      try {
        await executeD1("ALTER TABLE users ADD COLUMN tos_accepted INTEGER DEFAULT 1");
      } catch (e) {}
      try {
        await executeD1("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0");
      } catch (e) {}
      try {
        await executeD1("ALTER TABLE users ADD COLUMN locked_until INTEGER DEFAULT 0");
      } catch (e) {}

      return res.status(200).json({ status: 'success', msg: 'Database setup completed' });
    }

    // ── Dashboard stats ───────────────────────────────────────────────────
    if (action === 'dashboard') {
      const [users, sessions, payments, runners, queueLen] = await Promise.all([
        queryD1('SELECT COUNT(*) as cnt FROM users'),
        queryD1("SELECT COUNT(*) as cnt FROM vps_sessions WHERE status IN ('active','pending')"),
        queryD1("SELECT COUNT(*) as cnt FROM payments WHERE status = 'pending'"),
        redisCmd(['SMEMBERS', 'active_runners']),
        redisCmd(['ZCARD', 'vps_queue']),
      ]);

      // Get live runner details
      const runnerDetails = [];
      for (const rid of (runners || [])) {
        const data = await redisCmd(['GET', `runner:${rid}`]);
        if (data) {
          try { runnerDetails.push({ id: rid, ...JSON.parse(data) }); } catch (_) {}
        }
      }

      return res.status(200).json({
        status: 'success',
        stats: {
          total_users:      users[0]?.cnt || 0,
          active_sessions:  sessions[0]?.cnt || 0,
          pending_payments: payments[0]?.cnt || 0,
          active_runners:   runnerDetails.length,
          queue_depth:      queueLen || 0,
        },
        runners: runnerDetails,
      });
    }

    // ── List payments ─────────────────────────────────────────────────────
    if (action === 'list_payments') {
      const payments = await queryD1(`
        SELECT p.*, u.username, u.email
        FROM payments p
        JOIN users u ON p.user_id = u.id
        ORDER BY p.submitted_at DESC
      `);
      return res.status(200).json({ status: 'success', payments });
    }

    // ── Approve payment / upgrade user plan ───────────────────────────────
    if (action === 'approve_payment') {
      const { payment_id, user_id, plan } = req.body || {};
      if (!payment_id || !user_id || !plan) {
        return res.status(400).json({ status: 'error', msg: 'payment_id, user_id, plan required' });
      }
      await executeD1("UPDATE payments SET status='approved', reviewed_at=datetime('now') WHERE id=?", [payment_id]);
      await executeD1('UPDATE users SET plan=? WHERE id=?', [plan, user_id]);
      return res.status(200).json({ status: 'success', msg: `User ${user_id} upgraded to ${plan}` });
    }

    // ── List users ────────────────────────────────────────────────────────
    if (action === 'list_users') {
      const users = await queryD1(
        'SELECT id, username, email, plan, created_at, last_login, is_active FROM users ORDER BY created_at DESC LIMIT 100'
      );
      return res.status(200).json({ status: 'success', users });
    }

    // ── Flush Redis ───────────────────────────────────────────────────────
    if (action === 'flush_redis') {
      await redisCmd(['FLUSHALL']);
      return res.status(200).json({ status: 'success', msg: 'Redis flushed' });
    }

    // ── Wipe database ─────────────────────────────────────────────────────
    if (action === 'wipe_all') {
      await executeD1('DELETE FROM users');
      await executeD1('DELETE FROM vps_sessions');
      await executeD1('DELETE FROM payments');
      await executeD1('DELETE FROM activity_log');
      await executeD1('DELETE FROM auth_tokens');
      return res.status(200).json({ status: 'success', msg: 'Database wiped' });
    }

    return res.status(400).json({ status: 'error', msg: 'Unknown action' });

  } catch (err) {
    console.error('[Admin]', err);
    return res.status(500).json({ status: 'error', msg: err.message });
  }
}
