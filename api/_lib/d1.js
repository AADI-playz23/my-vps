export async function queryD1(sql, params = []) {
  const { CLOUDFLARE_ACCOUNT_ID, D1_DB_3_ID, D1_DB_2_ID, D1_DB_1_ID, D1_DB_ID, CLOUDFLARE_API_TOKEN } = process.env;
  const dbId = D1_DB_3_ID || D1_DB_2_ID || D1_DB_1_ID || D1_DB_ID;
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${dbId}/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params })
  });
  
  const data = await res.json();
  if (!data.success) {
    console.error('D1 Error:', data.errors);
    throw new Error('Database query failed: ' + JSON.stringify(data.errors));
  }
  return data.result[0].results;
}

export async function executeD1(sql, params = []) {
  return await queryD1(sql, params);
}
