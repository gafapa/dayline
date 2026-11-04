import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {postFixture} from './browser-fixture-request.mjs';
const base='http://127.0.0.1:5173',headers={'X-Kelvin-Client':'web','X-Kelvin-Document-Schema':'1'},suffix=Date.now();
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({storageState:process.env.BROWSER_STATE||'.local/browser-state.json',viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
context.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));let phase='setup';
const post=(path,data)=>postFixture(context.request,base+'/api'+path,headers,data);
const dialog=()=>page.getByRole('dialog',{name:/^Flujo de estados/});
try{
 const workspace=await post('/workspaces',{name:`Flujos verificados ${suffix}`}),ws=workspace.id;
 const make=async(kind,title,data={})=>(await post(`/workspaces/${ws}/mutate`,{operationId:crypto.randomUUID(),id:crypto.randomUUID(),expectedVersion:0,kind,title,data})).resource;
 const project=await make('project',`Proyecto con flujo ${suffix}`);
 const task=await make('task',`Tarea del flujo ${suffix}`,{projectId:project.id,status:'todo'});
 const snapshot=async id=>(await(await context.request.get(base+`/api/workspaces/${ws}/resources`)).json()).resources.find(r=>r.id===id);
 await page.goto(`${base}/?view=projects&workspace=${ws}`,{waitUntil:'domcontentloaded'});await page.getByText('Sincronizado',{exact:true}).waitFor();
 phase='configure';await page.getByRole('button',{name:'Flujo de estados',exact:true}).first().click();await dialog().waitFor();
 await dialog().getByRole('button',{name:'Añadir estado a Por hacer',exact:true}).click();await dialog().getByLabel('Nombre del estado 1 de Por hacer',{exact:true}).fill('Triaje');
 await dialog().getByRole('button',{name:'Añadir estado a Por hacer',exact:true}).click();await dialog().getByLabel('Nombre del estado 2 de Por hacer',{exact:true}).fill('Preparada');
 await dialog().getByRole('button',{name:'Añadir estado a En revisión',exact:true}).click();await dialog().getByLabel('Nombre del estado 1 de En revisión',{exact:true}).fill('QA');
 phase='edit states';await expect(dialog().getByLabel('Nombre del estado 2 de Por hacer',{exact:true})).toHaveValue('Preparada');
 await dialog().getByRole('button',{name:'Bajar Triaje',exact:true}).click();await expect(dialog().getByLabel('Nombre del estado 1 de Por hacer',{exact:true})).toHaveValue('Preparada');
 for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`docs/evidence/workflow-admin-${width}.png`});}
 await page.setViewportSize({width:1440,height:1000});
 phase='save';await dialog().getByRole('button',{name:'Guardar flujo',exact:true}).click();await dialog().waitFor({state:'hidden'});
 await expect.poll(async()=>(await snapshot(project.id))?.data.workflowStates?.map(s=>s.name).join(',')).toBe('Preparada,Triaje,QA');
 const saved=(await snapshot(project.id)).data.workflowStates,[prepared,triage,qa]=saved;
 phase='board columns';await page.goto(`${base}/?view=tasks&workspace=${ws}&project=${project.id}`,{waitUntil:'domcontentloaded'});await page.getByText('Sincronizado',{exact:true}).waitFor();
 const boardToggle=page.getByRole('button',{name:'Tablero',exact:true});const showBoard=async()=>{await boardToggle.waitFor();if(await boardToggle.getAttribute('aria-pressed')!=='true')await boardToggle.click();};await showBoard();
 await page.getByRole('region',{name:'Preparada',exact:true}).getByRole('button',{name:task.title,exact:true}).waitFor();
 assert.equal(await page.getByRole('region',{name:'Por hacer',exact:true}).count(),0,'categories with named states use them as columns');
 phase='move to named state';await page.getByLabel(`Estado de ${task.title}`,{exact:true}).selectOption(qa.id);
 await page.getByRole('region',{name:'QA',exact:true}).getByRole('button',{name:task.title,exact:true}).waitFor();
 await expect.poll(async()=>{const t=await snapshot(task.id);return `${t?.data.status}:${t?.data.stateId}`;}).toBe(`review:${qa.id}`);
 phase='offline state change';await page.waitForFunction(()=>!!navigator.serviceWorker.controller);await context.setOffline(true);
 await page.getByLabel(`Estado de ${task.title}`,{exact:true}).selectOption(triage.id);await page.getByRole('region',{name:'Triaje',exact:true}).getByRole('button',{name:task.title,exact:true}).waitFor();
 await page.reload({waitUntil:'domcontentloaded'});await showBoard();await page.getByRole('region',{name:'Triaje',exact:true}).getByRole('button',{name:task.title,exact:true}).waitFor();
 await context.setOffline(false);
 await expect.poll(async()=>{const t=await snapshot(task.id);return `${t?.data.status}:${t?.data.stateId}`;},{timeout:30000}).toBe(`todo:${triage.id}`);
 for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`docs/evidence/workflow-board-${width}.png`});}
 assert.equal(errors.length,0,errors.join('\n'));
 await writeFile('docs/evidence/workflow-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),syntheticData:true,checks:{configureNamedStates:true,reorderWithinCategory:true,namedBoardColumns:true,namedStateSelection:true,offlineStateChangeAndReload:true,reconnectPersistsCategoryAndState:true,responsiveWidths:[1440,768,390]},pageErrors:errors},null,2));
 console.info('Workflow configuration, named board columns, offline state changes and responsive layouts verified.');
}catch(error){console.error('Failed phase:',phase);await page.screenshot({path:'.local/workflow-failure.png',fullPage:true}).catch(()=>{});throw error;}finally{await browser.close();}
