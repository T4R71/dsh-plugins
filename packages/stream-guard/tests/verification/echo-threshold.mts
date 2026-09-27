// ECHO_MIN tuning on the STREAMING basis (max over text prefixes).
// positives all sit at 1.000, healthy max prefix is 0.7143 -> raising T widens the gap.
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
const rows=[]
for(const f of walk(ROOT)){const key=f.split(/[\\/]/).slice(-2)[0];let t;try{t=decode(f)}catch{continue}
 for(const line of t.split('\n')){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue}
  if(e?.type!=='assistant/message')continue;const c=e?.data?.message?.content;if(!Array.isArray(c))continue
  let r='',x='';for(const b of c){if(b?.type==='reasoning')r+=b.text??'';if(b?.type==='text')x+=b.text??''}
  if(r.length<1500&&x.length<1500)continue;rows.push({key,r,x})}}

// streaming scan: first prefix where lineEcho >= T (with MIN_LINES gate)
function scanAt(o,T,MINL){
 const R=new Set(units(o.r)); let buf='',seen=0,hit=0
 for(let i=0;i<o.x.length;i++){ if(o.x[i]!=='\n'){buf+=o.x[i];continue}
  const u=lab(buf); buf=''; if(u.length<2)continue
  seen++; if(R.has(u))hit++
  if(seen>=MINL&&hit/seen>=T) return i+1 } return -1 }
// max over prefixes (for the FP risk view)
function maxPrefix(o,MINL){
 const R=new Set(units(o.r)); let buf='',seen=0,hit=0,best=0
 for(let i=0;i<o.x.length;i++){ if(o.x[i]!=='\n'){buf+=o.x[i];continue}
  const u=lab(buf); buf=''; if(u.length<2)continue
  seen++; if(R.has(u))hit++
  if(seen>=MINL){const v=hit/seen; if(v>best)best=v} } return best }

const MINL=4
const cand=rows.filter(o=>o.x.length>=300)
const vals=cand.map(o=>({...o,max:maxPrefix(o,MINL),at:scanAt(o,0.8,MINL)}))
const truePos=new Set(vals.filter(v=>v.at>0).map(v=>v.key+'|'+v.r.length))
const healthyVals=vals.filter(v=>!truePos.has(v.key+'|'+v.r.length))
const healthyMax=Math.max(...healthyVals.map(v=>v.max))
console.log('=== streaming-basis threshold sweep (MIN_LINES='+MINL+') ===')
console.log('  known positives (fire at T=0.80): '+truePos.size)
console.log('  HEALTHY max prefix value = '+healthyMax.toFixed(4)+'   (closest healthy block: '+healthyVals.slice().sort((a,b)=>b.max-a.max)[0].key.slice(0,24)+')')
console.log('')
console.log('   T     触发  最迟判定点   与健康最大值间隔')
for(const T of [0.70,0.75,0.80,0.85,0.90,0.95,1.00]){
 const hits=cand.map(o=>({key:o.key,xlen:o.x.length,at:scanAt(o,T,MINL)})).filter(h=>h.at>0)
 const worst=hits.length?Math.max(...hits.map(h=>h.at)):-1
 console.log('  '+T.toFixed(2)+'   '+String(hits.length).padStart(3)+'    '+String(worst).padStart(7)+'      '+(T-healthyMax).toFixed(4)+(worst>1024?'   <-- OVER 1024':''))
}

console.log('')
console.log('=== does raising T change WHICH blocks fire? ===')
for(const T of [0.8,0.9,1.0]){
 const set=cand.filter(o=>scanAt(o,T,MINL)>0).map(o=>o.key+'|'+o.r.length)
 console.log('  T='+T.toFixed(2)+' -> '+set.length+' blocks: '+[...new Set(set.map(s=>s.split('|')[0].slice(0,20)))].join(', '))
}