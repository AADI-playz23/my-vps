import { queryD1, executeD1 } from './d1.js';
import { redisCmd } from './redis.js';

/**
 * Log a warning infraction and enforce 24-hour lockout or permanent ban.
 * @param {string} username - User to warn
 * @param {string} service - 'vps'
 * @param {string} reason - Infraction reason
 * @param {string} screenshotProofUrl - URL of uploaded proof
 * @returns {Promise<{warningCount: number, locked: boolean, banned: boolean}>}
 */
export async function triggerWarning(username, service, reason, screenshotProofUrl = '') {
  // 1. Log warning in warns table
  await executeD1(
    'INSERT INTO warns (username, service, reason, screenshot_proof) VALUES (?, ?, ?, ?)',
    [username, service, reason, screenshotProofUrl]
  );

  // 2. Count warnings
  const countRes = await queryD1(
    'SELECT COUNT(*) as cnt FROM warns WHERE username = ? AND service = ?',
    [username, service]
  );
  const warningCount = countRes[0]?.cnt || 0;

  // 3. Find user ID
  const users = await queryD1('SELECT id FROM users WHERE username = ?', [username]);
  const user = users[0];
  
  let locked = false;
  let banned = false;

  if (user) {
    const userId = user.id;

    if (warningCount > 3) {
      // Permanent ban
      await executeD1('UPDATE users SET banned = 1 WHERE id = ?', [userId]);
      await executeD1(
        'INSERT OR REPLACE INTO bans (username, service, reason) VALUES (?, ?, ?)',
        [username, service, reason]
      );
      banned = true;
    } else {
      // 24h lockout
      const lockUntil = Math.floor(Date.now() / 1000) + 24 * 3600;
      await executeD1('UPDATE users SET locked_until = ? WHERE id = ?', [lockUntil, userId]);
      locked = true;
    }

    // 4. Terminate sessions in D1 & Redis
    const activeSessions = await queryD1(
      "SELECT session_key FROM vps_sessions WHERE user_id = ? AND status != 'expired'",
      [userId]
    );

    await executeD1(
      "UPDATE vps_sessions SET status = 'expired' WHERE user_id = ?",
      [userId]
    );

    for (const sess of activeSessions) {
      const sessKey = sess.session_key;
      await redisCmd(['DEL', `session:${sessKey}`]);
      await redisCmd(['ZREM', 'vps_queue', sessKey]);
    }
  }

  return { warningCount, locked, banned };
}
