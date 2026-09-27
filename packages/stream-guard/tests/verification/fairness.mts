// FAIR STREAMING COMPARISON: both metrics evaluated as MAX OVER PREFIXES.
// (That is the basis that matters: a detector fires mid-stream, so the risk is
//  the highest value any healthy prefix reaches, not the value at the end.)
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const ROOT=join(process.env['USERPROFILE']??'','.dsh','sessions')
const MAGIC=Buffer.from([0x28,0xb5,0x2f,0xfd])
function walk(d,dep=0,out=[]){if(dep>3)return out;let es;try{es=readdirSync(d,{withFileTypes:true})}catch{return out}
 for(const e of es){const f=join(d,e.name);if(e.isDirectory())walk(f,dep+1,out);else if(e.name.endsWith('.jsonl.zstd'))out.push(f)}return out}
function decode(file){const b=readFileSync(file);const o=[];let at=b.indexOf(MAGIC)
 while(at!==-1){o.push(at);at=b.indexOf(MAGIC,at+4)}o.push(b.length);let t=''
 for(let i=0;i<o.length-1;i++){try{t+=zstdDecompressSync(b.subarray(o[i],o[i+1])).toString('utf8')}catch{}}return t}
const lab=(s)=>s.trim().toLowerCase().replace(/[.!?。！？,，:：;；]+$/g,'').replace(/\s+/g,' ')
const units=(t)=>t.split('\n').map(lab).filter(x=>x.length>=2)
const gramsOf=(t,n=8)=>{const s=t.replace(/\s+/g,' ');const o=new Set();for(let i=0;i+n<=s.length;i++)o.add(s.slice(i,i+n));return o}

const rows=[]
for(const f of walk(ROOT)){const key=f.split(/[\\/]/).slice(-2)[0];let t;try{t=decode(f)}catch{continue}
 for(const line of t.split('\n')){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue}
  if(e?.type!=='assistant/message')continue;const c=e?.data?.message?.content;if(!Array.isArray(c))continue
  let r='',x='';for(const b of c){if(b?.type==='reasoning')r+=b.text??'';if(b?.type==='text')x+=b.text??''}
  if(r.length<1500&&x.length<1500)continue;rows.push({key,r,x})}}

// max over streaming prefixes for BOTH metrics
function maxPrefixLE(o){
 const R=new Set(units(o.r)); const ls=[]; let buf='',seen=0,hit=0,best=0
 for(let i=0;i<o.x.length;i++){ if(o.x[i]!=='\n'){buf+=o.x[i];continue}
  const u=lab(buf); buf=''; if(u.length<2)continue
  seen++; if(R.has(u))hit++;
  if(seen>=1){const v=hit/seen; if(v>best)best=v} } return best }
function maxPrefixER(o){
 const A=gramsOf(o.r); if(A.size===0)return 0; let best=0
 for(let L=64;L<=o.x.length;L+=64){const G=gramsOf(o.x.slice(0,L)); if(G.size===0)continue
  let h=0; for(const g of G)if(A.has(g))h++; const v=h/G.size; if(v>best)best=v } return best }

console.log('=== MAX-OVER-PREFIXES (honest streaming FP risk), text >= 1024 ===')
const cand=rows.filter(o=>o.x.length>=1024)
const scored=cand.map(o=>({...o,le:maxPrefixLE(o),er:maxPrefixER(o)}))
const lePos=scored.filter(o=>o.le>=0.8), leNeg=scored.filter(o=>o.le<0.8)
const erPos=scored.filter(o=>o.er>=0.9), erNeg=scored.filter(o=>o.er<0.9)
console.log('  blocks: '+scored.length)
console.log('')
console.log('  lineEcho  (T=0.80): fires='+lePos.length+'  healthy max = '+Math.max(...leNeg.map(o=>o.le)).toFixed(4)+'  gap = '+(lePos.length?Math.min(...lePos.map(o=>o.le)).toFixed(4):'-')+' -> '+(lePos.length?(0.8-Math.max(...leNeg.map(o=>o.le))).toFixed(4):'-'))
console.log('  8gram     (T=0.90): fires='+erPos.length+'  healthy max = '+Math.max(...erNeg.map(o=>o.er)).toFixed(4)+'  gap = '+(erPos.length?Math.min(...erPos.map(o=>o.er)).toFixed(4):'-')+' -> '+(erPos.length?(0.9-Math.max(...erNeg.map(o=>o.er))).toFixed(4):'-'))
console.log('')
console.log('  top healthy by lineEcho (max-over-prefix):')
for(const o of leNeg.sort((a,b)=>b.le-a.le).slice(0,8)) console.log('    le='+o.le.toFixed(3)+' er='+o.er.toFixed(3)+' lenT='+String(o.x.length).padStart(7)+'  '+o.key.slice(0,24))
console.log('')
console.log('  top healthy by 8gram (max-over-prefix):')
for(const o of erNeg.sort((a,b)=>b.er-a.er).slice(0,8)) console.log('    er='+o.er.toFixed(3)+' le='+o.le.toFixed(3)+' lenT='+String(o.x.length).padStart(7)+'  '+o.key.slice(0,24))
console.log('')
console.log('  => the metric with the WIDER gap at its own threshold is safer.')