import { queryD1, executeD1 } from './_lib/d1.js';
import { redisCmd } from './_lib/redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action || '';
  
  try {
    if (action === 'setup') {
      const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            plan TEXT NOT NULL DEFAULT 'free',
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
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
        )`
      ];

      for (const sql of queries) {
        await executeD1(sql);
      }
      return res.status(200).json({ status: 'success', msg: 'Setup completed for D1' });
    }

    const adminKey = req.query.admin_key || req.body?.admin_key || '';
    if (adminKey !== process.env.ABSORACLOUD_ADMIN_SECRET) {
      return res.status(401).json({ status: 'error', msg: 'Unauthorized admin access' });
    }

    if (action === 'list_payments') {
      const payments = await queryD1(`
        SELECT p.*, u.username, u.email 
        FROM payments p 
        JOIN users u ON p.user_id = u.id 
        ORDER BY p.submitted_at DESC
      `);
      return res.status(200).json({ status: 'success', payments });
    }

    if (action === 'wipe_all') {
      await executeD1('DELETE FROM users');
      await executeD1('DELETE FROM vps_sessions');
      await executeD1('DELETE FROM payments');
      await executeD1('DELETE FROM activity_log');
      await executeD1('DELETE FROM auth_tokens');
      return res.status(200).json({ status: 'success', msg: 'Database wiped' });
    }
    
    if (action === 'flush') {
      await redisCmd(['FLUSHALL']);
      return res.status(200).json({ status: 'success', msg: 'Redis flushed' });
    }

    return res.status(400).json({ status: 'error', msg: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', msg: err.message });
  }
}
