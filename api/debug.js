/**
 * GET /api/debug
 *
 * Safe diagnostic endpoint — shows which environment variables are SET
 * (true/false only, never the actual values).
 *
 * Use this to confirm Vercel has all secrets configured correctly
 * before blaming the code for runner failures.
 *
 * Remove or protect this endpoint after debugging is complete.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', msg: 'Method not allowed' });
  }

  const env = process.env;

  const vars = {
    // GitHub Runner Trigger (REQUIRED)
    GH_TOKEN:    !!env.GH_TOKEN,
    GH_OWNER:    env.GH_OWNER   || '(not set)',
    GH_REPO:     env.GH_REPO    || '(not set)',

    // Cloudflare D1 (REQUIRED)
    CLOUDFLARE_ACCOUNT_ID: !!env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN:  !!env.CLOUDFLARE_API_TOKEN,
    D1_DB_ID:              !!env.D1_DB_ID,
    D1_DB_1_ID:            !!env.D1_DB_1_ID,
    D1_DB_2_ID:            !!env.D1_DB_2_ID,
    D1_DB_3_ID:            !!env.D1_DB_3_ID,

    // Upstash Redis (REQUIRED)
    UPSTASH_URL:   !!env.UPSTASH_URL,
    UPSTASH_TOKEN: !!env.UPSTASH_TOKEN,

    // Gemini AI (optional — disabling = all abuse auto-confirmed)
    GEMINI_API_KEY: !!env.GEMINI_API_KEY,

    // Admin
    ADMIN_SETUP_KEY: !!env.ADMIN_SETUP_KEY,

    // Forensics GitHub repo (optional)
    GITHUB_TOKEN:          !!env.GITHUB_TOKEN,
    GITHUB_REPO_FORENSICS: env.GITHUB_REPO_FORENSICS || '(not set)',
    GITHUB_REPO:           env.GITHUB_REPO           || '(not set)',

    // App URL
    BASE_URL: env.BASE_URL || '(not set)',
  };

  // Summarise what's missing
  const required = ['GH_TOKEN', 'GH_OWNER', 'GH_REPO', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'UPSTASH_URL', 'UPSTASH_TOKEN'];
  const missing  = required.filter(k => !env[k]);

  return res.status(200).json({
    status: missing.length === 0 ? 'all_required_set' : 'missing_required_vars',
    missing_required: missing,
    vars,
    note: 'GH_OWNER and GH_REPO are shown in plain text to help debug 404 errors. Remove this endpoint after setup.',
    github_dispatch_url: (env.GH_OWNER && env.GH_REPO)
      ? `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`
      : '(GH_OWNER or GH_REPO not set)',
  });
}
