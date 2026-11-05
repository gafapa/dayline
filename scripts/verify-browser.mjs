import {request} from '@playwright/test';
import {spawn} from 'node:child_process';
import {open,readFile,access} from 'node:fs/promises';
const state=process.env.BROWSER_STATE||'.local/browser-state.json';
// --quick: the core flows (a few minutes). No arguments: every check.
const quick=process.argv.includes('--quick');const names=process.argv.slice(2).filter(a=>a!=='--quick');if(quick&&!names.length)names.push('features-check','navigation-check','offline-check','workflow-check','dnd-check');if(!names.length)names.push('browser-check','features-check','collections-check','sprints-check','offline-check','automations-check','delivery-check','navigation-check','collaboration-access-check','hierarchy-check','custom-fields-check','dashboard-check','session-lifecycle-check','time-tracking-check','personal-notes-check','notification-settings-check','reminders-check','quick-capture-check','workflow-check','workspaces-check','platform-check','dnd-check','inbox-check','palette-check');
const budgets={'dnd-check':120,'palette-check':60,'inbox-check':60,'browser-check':70,'features-check':110,'collections-check':165,'sprints-check':180,'offline-check':85,'automations-check':120,'delivery-check':185,'navigation-check':205,'collaboration-access-check':80,'hierarchy-check':150,'custom-fields-check':210,'dashboard-check':210,'session-lifecycle-check':210,'time-tracking-check':215,'personal-notes-check':200,'notification-settings-check':100,'reminders-check':210,'quick-capture-check':230,'workflow-check':120,'workspaces-check':80,'platform-check':90};
async function quota(name){
  try{await access(state);}catch{return;}
  while(true){
    const client=await request.newContext({storageState:state});let response;
    try{response=await client.get('http://127.0.0.1:5173/api/me');const headers=response.headers(),remaining=Number(headers['x-ratelimit-remaining']),reset=Number(headers['x-ratelimit-reset']);
      if(response.status()===401)throw new Error('The synthetic browser session has expired. Run browser-check without BROWSER_STATE first.');
      if(![200,429].includes(response.status()))throw new Error('Synthetic quota probe failed.');
      if(response.status()===200&&(!Number.isFinite(remaining)||remaining>=(budgets[name]||80)))return;
      if(!Number.isFinite(reset)||reset<0)throw new Error('Quota reset time unavailable.');
      const wait=Math.min(60000,(reset+1)*1000);console.info(`${name}: waiting ${Math.ceil(wait/1000)}s for the server quota window.`);await new Promise(resolve=>setTimeout(resolve,wait));
    }finally{await client.dispose();}
  }
}
for(const name of names){
  if(!/^[a-z-]+$/.test(name))throw new Error('Invalid verification script name');
  await quota(name);
  const file=await open(`.local/navigation-final-${name}.log`,'w');
  let exit;
  try{exit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[`scripts/${name}.mjs`],{env:{...process.env,BROWSER_STATE:state},stdio:['ignore',file.fd,file.fd]});child.on('error',reject);child.on('close',resolve);});}finally{await file.close();}
  if(exit!==0){const output=await readFile(`.local/navigation-final-${name}.log`,'utf8');console.error(output.split('\n').slice(-28).join('\n'));throw new Error(`Verification failed: ${name}`);}
  console.info(`${name} passed`);
}
