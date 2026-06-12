export async function redisCmd(args) {
  const { UPSTASH_URL, UPSTASH_TOKEN } = process.env;
  
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export function redisParseHash(arr) {
  if (!arr) return {};
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) {
    obj[arr[i]] = arr[i + 1];
  }
  return obj;
}
