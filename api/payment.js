import { queryD1, executeD1 } from './_lib/d1.js';
import { getPlans } from './_lib/plans.js';

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

    const action = req.query.action || req.body?.action || '';

    if (action === 'submit') {
      const plan = req.body.plan;
      const screenshotUrl = req.body.screenshot_url; // Expect CDN link from Uploadcare widget
      const plans = getPlans();

      if (!plans[plan] || plan === 'free') {
        return res.status(400).json({ status: 'error', msg: 'Invalid plan' });
      }

      const amount = plans[plan].price;

      await executeD1(`
        INSERT INTO payments (user_id, plan, amount, screenshot, status, reviewed_at) 
        VALUES (?, ?, ?, ?, 'approved', datetime('now'))
      `, [userId, plan, amount, screenshotUrl || null]);

      await executeD1('UPDATE users SET plan = ? WHERE id = ?', [plan, userId]);

      return res.status(200).json({
        status: 'success',
        msg: `Payment received! Your plan has been upgraded to ${plans[plan].name}.`,
        plan,
        plan_info: plans[plan]
      });
    }

    return res.status(400).json({ status: 'error', msg: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', msg: err.message });
  }
}
