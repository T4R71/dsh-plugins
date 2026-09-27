// Re-measure with the channel policy: on reasoning, only intent evidence brakes.
import { AnnounceGuard } from '../../src/announce.ts'
import { RepeatGuard } from '../../src/repeat.ts'
import { EchoGuard } from '../../src/echo.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const BRAKE_REASONING=false
const ROOT=join(process.env['USERPROFILE']??'','.dsh','sessions')
const MAGIC=Buffer.from([0x28,0xb5,0x2f,0xfd])
function walk2(d,dep=0,out=[]){if(dep>3)return out;let es;try{es=readdirSync(d,{withFileTypes:true})}catch{return out}
 for(const e of es){const f=join(d,e.name);if(e.isDirectory())walk2(f,dep+1,out);else if(e.name.endsWith('.jsonl.zstd'))out.push(f)}return out}
function decode(file){const b=readFileSync(file);const o=[];let at=b.indexOf(MAGIC)
 while(at!==-1){o.push(at);at=b.indexOf(MAGIC,at+4)}o.push(b.length);let t=''
 for(let i=0;i<o.length-1;i++){try{t+=zstdDecompressSync(b.subarray(o[i],o[i+1])).toString('utf8')}catch{}}return t}
const rows=[]
for(const f of walk2(ROOT)){const key=f.split(/[\\/]/).slice(-2)[0];let t;try{t=decode(f)}catch{continue}
 for(const line of t.split('\n')){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue}
  if(e?.type!=='assistant/message')continue;const c=e?.data?.message?.content;if(!Array.isArray(c))continue
  let r='',x='';for(const b of c){if(b?.type==='reasoning')r+=b.text??'';if(b?.type==='text')x+=b.text??''}
  if(r.length<1500&&x.length<1500)continue;rows.push({key,r,x})}}
const hits=[]
for(const o of rows){
 const ag={text:new AnnounceGuard(),reasoning:new AnnounceGuard()}
 const rg={text:new RepeatGuard(),reasoning:new RepeatGuard()}
 const eg=new EchoGuard(); let fired=null
 const step=(ch,t)=>{
  if(ch==='reasoning')eg.feedReasoning(t); else { if(eg.feedText(t))fired='echo' }
  if(!fired&&rg[ch].feed(t))fired='repeat'
  if(!fired){const av=ag[ch].feed(t)
   if(av&&(ch==='text'||BRAKE_REASONING||av.kind==='intent'))fired='announce/'+av.kind}}
 step('reasoning',o.r); if(!fired) step('text',o.x)
 if(fired)hits.push({key:o.key.slice(0,22),fired}) }
const by={}; for(const h of hits) by[h.fired]=(by[h.fired]??0)+1
console.log('blocks: '+rows.length)
console.log('total fires: '+hits.length)
console.log('by rule: '+JSON.stringify(by))