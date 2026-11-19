// Runs the browser checks against a running `npm run preview:test`.
//   node scripts/verify-browser.mjs                 every check
//   node scripts/verify-browser.mjs --quick         the core flows
//   node scripts/verify-browser.mjs dnd-check …     only these
//   --jobs N   checks at a time (default 4). Checks that read user-wide state (inbox, notification
//              settings, the workspace list, sessions, the platform) run afterwards, one by one.
// A check that fails is run once more on its own; passing then is reported as flaky.
import {request} from '@playwright/test';
import {spawn} from 'node:child_process';
import {open,readFile,access,copyFile} from 'node:fs/promises';
const state=process.env.BROWSER_STATE||'.local/browser-state.json';
const args=process.argv.slice(2),quick=args.includes('--quick');
const jobsArg=args.indexOf('--jobs'),jobs=Math.max(1,Number(jobsArg>=0?args[jobsArg+1]:4)||4);
const names=args.filter((a,i)=>!a.startsWith('--')&&!(jobsArg>=0&&i===jobsArg+1));
const all=['browser-check','features-check','collections-check','sprints-check','offline-check','automations-check','delivery-check','navigation-check','collaboration-access-check','hierarchy-check','custom-fields-check','dashboard-check','time-tracking-check','personal-notes-check','quick-capture-check','workflow-check','dnd-check','session-lifecycle-check','notification-settings-check','reminders-check','workspaces-check','platform-check','inbox-check','palette-check'];
const alone=new Set(['session-lifecycle-check','notification-settings-check','reminders-check','workspaces-check','platform-check','inbox-check','palette-check']);
if(!names.length)names.push(...(quick?['browser-check','features-check','navigation-check','offline-check','workflow-check','dnd-check']:all));
for(const name of names)if(!/^[a-z-]+-check$/.test(name))throw new Error(`Invalid verification script name: ${name}`);
const budgets={'dnd-check':120,'palette-check':60,'inbox-check':60,'browser-check':70,'features-check':110,'collections-check':165,'sprints-check':180,'offline-check':85,'automations-check':120,'delivery-check':185,'navigation-check':205,'collaboration-access-check':80,'hierarchy-check':150,'custom-fields-check':210,'dashboard-check':210,'session-lifecycle-check':210,'time-tracking-check':215,'personal-notes-check':200,'notification-settings-check':100,'reminders-check':210,'quick-capture-check':230,'workflow-check':120,'workspaces-check':80,'platform-check':90};
/** Waits while the synthetic account is close to the server's request quota. */
async function quota(name){
  try{await access(state);}catch{return;}
  while(true){
    const client=await request.newContext({storageState:state});
    try{const response=await client.get('http://127.0.0.1:5173/api/me'),headers=response.headers(),remaining=Number(headers['x-ratelimit-remaining']),reset=Number(headers['x-ratelimit-reset']);
      if(response.status()===401)throw new Error('The synthetic browser session has expired. Run browser-check without BROWSER_STATE first.');
      if(![200,429].includes(response.status()))throw new Error('Synthetic quota probe failed.');
      if(response.status()===200&&(!Number.isFinite(remaining)||remaining>=(budgets[name]||80)*jobs))return;
      if(!Number.isFinite(reset)||reset<0)throw new Error('Quota reset time unavailable.');
      const wait=Math.min(60000,(reset+1)*1000);console.info(`${name}: waiting ${Math.ceil(wait/1000)}s for the server quota window.`);await new Promise(resolve=>setTimeout(resolve,wait));
    }finally{await client.dispose();}
  }
}
const log=name=>`.local/navigation-final-${name}.log`;
async function run(name){
  await quota(name);
  const file=await open(log(name),'w'),started=Date.now();
  const saved=await access(state).then(()=>true,()=>false),env={...process.env};if(saved)env.BROWSER_STATE=state;else delete env.BROWSER_STATE;
  try{return {exit:await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[`scripts/${name}.mjs`],{env,stdio:['ignore',file.fd,file.fd]});child.on('error',reject);child.on('close',resolve);}),seconds:Math.round((Date.now()-started)/1000)};}
  finally{await file.close();}
}
const results=[],failed=[];
async function check(name){
  let {exit,seconds}=await run(name);
  if(exit===0){results.push([name,seconds,'']);console.info(`${name} passed (${seconds}s)`);return;}
  failed.push(name);await copyFile(log(name),log(name).replace(/\.log$/,'-first-failure.log'));console.info(`${name} failed (${seconds}s), will retry alone (first log: ${log(name).replace(/\.log$/,'-first-failure.log')})`);
}
const started=Date.now(),queue=names.filter(n=>!alone.has(n)),lone=names.filter(n=>alone.has(n));
// browser-check signs the synthetic account in and saves its session: without one it goes first.
if(queue.includes('browser-check')&&!(await access(state).then(()=>true,()=>false))){
  queue.splice(queue.indexOf('browser-check'),1);const {exit}=await run('browser-check');
  if(exit!==0){console.error((await readFile(log('browser-check'),'utf8')).split('\n').slice(-28).join('\n'));console.error('browser-check could not set up the synthetic account; the other checks need it.');process.exit(1);}
  results.push(['browser-check',0,'']);console.info('browser-check passed (account set up)');
}
await Promise.all(Array.from({length:Math.min(jobs,queue.length)},async()=>{while(queue.length)await check(queue.shift());}));
for(const name of lone)await check(name);
const broken=[];
for(const name of failed){
  const {exit,seconds}=await run(name);
  if(exit===0){results.push([name,seconds,'flaky']);console.info(`${name} passed on retry (${seconds}s): FLAKY, look at it`);}
  else{broken.push(name);const output=await readFile(log(name),'utf8');console.error(`\n--- ${name} ---\n`+output.split('\n').slice(-28).join('\n'));}
}
const slowest=results.sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,s])=>`${n} ${s}s`).join(', ');
console.info(`\n${results.length}/${names.length} checks passed in ${Math.round((Date.now()-started)/1000)}s with ${jobs} at a time. Slowest: ${slowest}.`);
if(results.some(r=>r[2]))console.info(`Flaky: ${results.filter(r=>r[2]).map(r=>r[0]).join(', ')}`);
if(broken.length){console.error(`Failed: ${broken.join(', ')} (logs in .local/navigation-final-<name>.log)`);process.exit(1);}
