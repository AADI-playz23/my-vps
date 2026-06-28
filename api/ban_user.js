import { queryD1, executeD1 } from './_lib/d1.js';
import { triggerWarning } from './_lib/abuse_guard.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });

  const op = req.body.op || '';
  if (op !== 'ban_user' && op !== 'report_abuse') {
    return res.status(400).json({ status: "error", message: "Invalid operation" });
  }

  const { runner_id, session_id, screenshot_base64, console_dump, force_warn } = req.body;
  if (!session_id) {
    return res.status(400).json({ status: "error", message: "Missing session_id" });
  }

  try {
    // 1. Resolve session to user ID and user details
    const sessResult = await queryD1(
      'SELECT s.user_id, u.username FROM vps_sessions s JOIN users u ON s.user_id = u.id WHERE s.session_key = ?',
      [session_id]
    );

    if (sessResult.length === 0) {
      return res.status(404).json({ status: "error", message: "Session not found" });
    }

    const { username } = sessResult[0];
    let abuseDetected = false;
    let reason = "Suspected policy violation";
    let proofUrl = "";

    // 2. Gemini Verification
    if (force_warn) {
      abuseDetected = true;
      reason = force_warn;
    } else if (process.env.GEMINI_API_KEY) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const parts = [
          {
            text: "Analyze this image and text content from a VPS terminal/instance session. Detect if there is cryptocurrency mining (e.g. xmrig, ethminer, stratum), adult website hosting, or container escape attempts. Respond ONLY in valid JSON format with two keys: 'abuse_detected' (boolean) and 'reason' (string detailing the finding)."
          }
        ];

        if (screenshot_base64) {
          parts.push({
            inlineData: {
              mimeType: "image/png",
              data: screenshot_base64
            }
          });
        }
        if (console_dump) {
          parts.push({
            text: `Terminal Console log:\n${console_dump}`
          });
        }

        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });

        const geminiData = await geminiRes.json();
        const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const parsed = JSON.parse(responseText);
          abuseDetected = parsed.abuse_detected;
          reason = parsed.reason || reason;
        }
      } catch (err) {
        console.error("Gemini analysis error:", err);
        abuseDetected = true; 
      }
    } else {
      abuseDetected = true;
    }

    if (!abuseDetected) {
      return res.status(200).json({ status: "success", message: "No abuse detected. Session left intact." });
    }

    // 3. Upload proof to private GitHub repository
    const targetRepo = process.env.GITHUB_REPO_VPS || process.env.GITHUB_REPO_FORENSICS || process.env.GITHUB_REPO;
    if (process.env.GITHUB_TOKEN && targetRepo) {
      try {
        const [owner, repo] = targetRepo.split('/');
        const timestamp = Date.now();
        const path = `forensics/vps_${username}_${session_id}_${timestamp}.png`;
        const uploadUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

        const contentBase64 = screenshot_base64 || Buffer.from(console_dump || reason).toString('base64');

        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `token ${process.env.GITHUB_TOKEN}`,
            'User-Agent': 'AbsoraCloud-Vercel',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: `forensic proof for VPS user ${username} on ${session_id}`,
            content: contentBase64
          })
        });

        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          proofUrl = uploadData?.content?.html_url || `https://github.com/${owner}/${repo}/blob/main/${path}`;
        }
      } catch (err) {
        console.error("GitHub upload failed:", err);
      }
    }

    // 4. Trigger warning & lockout logic
    const { warningCount, locked, banned } = await triggerWarning(username, 'vps', reason, proofUrl);

    return res.status(200).json({
      status: "success",
      abuse_detected: true,
      reason,
      warning_count: warningCount,
      locked,
      banned,
      proof_url: proofUrl
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "error", message: e.message });
  }
}
