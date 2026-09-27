// Measure first-fire offsets for each bleed under the NEW two-layer design.
import { AnnounceGuard } from '../../src/announce.ts'
import { RepeatGuard } from '../../src/repeat.ts'
import { EchoGuard } from '../../src/echo.ts'
function firstFire(text: string){
  const a=new AnnounceGuard(), r=new RepeatGuard(), e=new EchoGuard()
  let seen=0
  for(const ch of Array.from(text)){
    seen++
    let rule: string|null=null
    if(e.feedText(ch))rule='echo'
    if(rule===null&&r.feed(ch))rule='repeat'
    if(rule===null){const av=a.feed(ch); if(av)rule='announce/'+av.kind}
    if(rule!==null)return {rule, by:seen}
  }
  return {rule:null, by:-1}
}
const BLEEDS: [string,string][]=[
 ['Latin pool the lexicon knows','Let me write it.\n'.repeat(300)],
 ['CJK phrase the lexicon knows','让我来写。\n'.repeat(300)],
 ['Latin pool outside the lexicon','Pondering the matter.\n'.repeat(300)],
 ['CJK pool the lexicon is blind to','好。执行。'.repeat(600)],
 ['one long line repeated','The same long sentence over and over again. '.repeat(400)],
 ['hesitation churn',Array.from({length:400},(_,i)=>i%2===0?'Hmm.':'Wait.').join('\n')+'\n'],
 ['character cycle with no newlines','abcdefgh'.repeat(600)],
]
for(const [name,text] of BLEEDS){const f=firstFire(text); console.log(name.padEnd(34)+' -> '+(f.rule??'MISS').padEnd(16)+' by '+f.by)}
console.log('')
const table=Array.from({length:300},(_,i)=>'| row '+i+' | value '+(i*7)+' |').join('\n')+'\n'
const prose=Array.from({length:200},(_,i)=>'Paragraph '+i+' explaining a distinct point in ordinary language.').join('\n')+'\n'
console.log('markdown table -> '+JSON.stringify(firstFire(table)))
console.log('distinct prose  -> '+JSON.stringify(firstFire(prose)))
console.log('')
// Control: with layer two disabled, which bleeds survive?
function layer1Only(text: string){const a=new AnnounceGuard(); let seen=0
 for(const ch of Array.from(text)){seen++; const av=a.feed(ch); if(av)return {rule:'announce/'+av.kind, by:seen}} return {rule:null,by:-1}}
const missed=BLEEDS.filter(([,t])=>layer1Only(t).rule===null).map(([n])=>n)
console.log('layer-2 disabled misses ('+missed.length+' of '+BLEEDS.length+'):')
for(const m of missed) console.log('  '+m)