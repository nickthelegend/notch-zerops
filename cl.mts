import { ZeropsClient } from './src/zerops/api.js';
const c = new ZeropsClient(process.env.ZEROPS_TOKEN!);
const [p] = await c.projects(); const KEEP=new Set(['core','ubuntu','zcp']);
for (const s of (await c.services(p!.id)).filter(x=>!KEEP.has(x.name))) await c.deleteService(s.id).catch(()=>{});
for(let i=0;i<14;i++){await new Promise(r=>setTimeout(r,6000));
  const e=(await c.services(p!.id)).filter(x=>!KEEP.has(x.name));
  if(!e.length){console.log('account clean');break;}}
