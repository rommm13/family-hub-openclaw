import {createHmac,timingSafeEqual} from 'node:crypto';
export function validateInitData(raw, botToken, now=Date.now()) {
  if(typeof raw!=='string' || raw.length>8192 || !botToken)return null;
  const fields=new URLSearchParams(raw), hash=fields.get('hash');
  if(!hash || !/^[a-f0-9]{64}$/i.test(hash))return null;
  const t=Number(fields.get('auth_date'));
  if(!Number.isSafeInteger(t) || t*1000>now+60000 || now-t*1000>86400000)return null;
  const data=[...fields].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(botToken).digest();
  const expected=createHmac('sha256',secret).update(data).digest();
  if(!timingSafeEqual(expected,Buffer.from(hash,'hex')))return null;
  try {const user=JSON.parse(fields.get('user')||'{}');return Number.isSafeInteger(Number(user.id))&&Number(user.id)>0?user:null;}catch{return null;}
}
