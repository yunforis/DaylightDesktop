// Native apps carry bearer tokens, never cookies. Only configured origins get access.
export function mobileCors({ origins = process.env.DAYLIGHT_MOBILE_ORIGINS || 'capacitor://localhost' } = {}) {
  const allowed=new Set(origins.split(',').map(value=>value.trim()).filter(Boolean));
  return (req,res,next)=>{
    const origin=req.get('Origin');
    if(!origin || !allowed.has(origin)) return next();
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,X-Mailbox-Id,Idempotency-Key,Accept');
    res.setHeader('Access-Control-Expose-Headers','Content-Disposition,Content-Type');
    if(req.method==='OPTIONS') return res.status(204).end();
    next();
  };
}
