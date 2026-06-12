import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { queryD1, executeD1 } from './_lib/d1.js';
import { getPlans } from './_lib/plans.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action || '';

  try {
    if (action === 'register') {
      const { username, email, password } = req.body;
      if (!username || !email || !password) return res.status(400).json({ status: 'error', msg: 'All fields required' });
      if (username.length < 3) return res.status(400).json({ status: 'error', msg: 'Username too short' });
      if (password.length < 6) return res.status(400).json({ status: 'error', msg: 'Password too short' });

      const hash = await bcrypt.hash(password, 10);
      
      try {
        await executeD1('INSERT INTO users (username, email, password, plan) VALUES (?, ?, ?, ?)', [username, email, hash, 'free']);
      } catch (err) {
        return res.status(400).json({ status: 'error', msg: 'Username or email already taken.' });
      }

      const users = await queryD1('SELECT * FROM users WHERE username = ?', [username]);
      const user = users[0];
      const token = uuidv4();
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      await executeD1('INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, token, expiresAt.toISOString().slice(0, 19).replace('T', ' ')]);

      return res.status(200).json({
        status: 'success',
        token,
        user: { id: user.id, username: user.username, email: user.email, plan: user.plan }
      });
    }

    if (action === 'login') {
      const { login, password } = req.body;
      if (!login || !password) return res.status(400).json({ status: 'error', msg: 'Login and password required' });

      const users = await queryD1('SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1', [login, login]);
      const user = users[0];
      if (!user) return res.status(401).json({ status: 'error', msg: 'Invalid credentials' });

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ status: 'error', msg: 'Invalid credentials' });

      await executeD1("UPDATE users SET last_login = datetime('now') WHERE id = ?", [user.id]);
      
      const token = uuidv4();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      await executeD1('INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, token, expiresAt.toISOString().slice(0, 19).replace('T', ' ')]);

      return res.status(200).json({
        status: 'success',
        token,
        user: { id: user.id, username: user.username, email: user.email, plan: user.plan }
      });
    }

    // Protect routes below this point
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ status: 'error', msg: 'Not logged in' });

    const tokens = await queryD1('SELECT * FROM auth_tokens WHERE token = ? AND expires_at > datetime("now")', [token]);
    if (tokens.length === 0) return res.status(401).json({ status: 'error', msg: 'Invalid or expired token' });
    
    const userId = tokens[0].user_id;

    if (action === 'logout') {
      await executeD1('DELETE FROM auth_tokens WHERE token = ?', [token]);
      return res.status(200).json({ status: 'success' });
    }

    if (action === 'me') {
      const users = await queryD1('SELECT id, username, email, plan, created_at, last_login FROM users WHERE id = ?', [userId]);
      const user = users[0];
      if (!user) return res.status(404).json({ status: 'error', msg: 'User not found' });
      
      const plans = getPlans();
      return res.status(200).json({ status: 'success', user, plan_info: plans[user.plan] });
    }

    if (action === 'upgrade') {
      const { plan } = req.body;
      const plans = getPlans();
      if (!plans[plan] || plan === 'free') return res.status(400).json({ status: 'error', msg: 'Invalid plan' });
      
      await executeD1('UPDATE users SET plan = ? WHERE id = ?', [plan, userId]);
      return res.status(200).json({ status: 'success', plan, plan_info: plans[plan] });
    }

    return res.status(400).json({ status: 'error', msg: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', msg: err.message });
  }
}
