import { chromium, expect } from '@playwright/test';
import { openSection } from './navigation-helper.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:5173';
const headers = {'X-Kelvin-Client':'web','X-Kelvin-Document-Schema':'1'};
const browser = await chromium.launch({channel:'msedge',headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
context.setDefaultTimeout(15000);
const errors = [], pages = [];
const newPage = async () => {const page=await context.newPage(); pages.push(page); page.on('pageerror', error=>errors.push(error.message)); return page;};
async function post(path,data) {
  const response=await context.request.post(base+'/api'+path,{headers,data});
  assert.equal(response.status(),200,await response.text()); return response.json();
}
const openDatabase = async (page,userId,work) => page.evaluate(async ({userId,work})=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(`kelvin-${userId}`,2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try {
    if(work==='pending') return await new Promise(resolve=>{const r=db.transaction('outbox').objectStore('outbox').getAll();r.onsuccess=()=>resolve(r.result);});
    return await new Promise(resolve=>{const r=db.transaction('metadata').objectStore('metadata').getAllKeys();r.onsuccess=()=>resolve(r.result);});
  } finally {db.close();}
},{userId,work});
let phase='login';
try {
  await post('/login',{email:'browser@example.test',password:'browser-test-password-long'});
  const profile=await (await context.request.get(base+'/api/me')).json(), userId=profile.user.id;
  const workspace=await post('/workspaces',{name:`Session safety ${Date.now()}`}), ws=workspace.id;
  const task=(await post(`/workspaces/${ws}/mutate`,{operationId:crypto.randomUUID(),id:crypto.randomUUID(),kind:'task',title:'Concurrent draft',data:{status:'todo'},expectedVersion:0})).resource;
  const raw=await newPage();await raw.goto(base+'/mark.svg');
  await raw.evaluate(async userId=>{
    window.held=await new Promise(resolve=>{const request=indexedDB.open(`kelvin-${userId}`,1);request.onupgradeneeded=()=>{request.result.createObjectStore('snapshots');request.result.createObjectStore('outbox',{keyPath:'key'});};request.onsuccess=()=>resolve(request.result);});
  },userId);
  phase='blocked upgrade';
  const a=await newPage();await a.goto(`${base}/?view=tasks&workspace=${ws}`,{waitUntil:'domcontentloaded'});
  await expect(a.getByRole('alert',{name:'Almacenamiento local'})).toContainText('Esperando al almacenamiento local');
  await a.setViewportSize({width:390,height:844});
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await a.screenshot({path:'docs/evidence/storage-blocked-mobile.png'});
  await raw.evaluate(()=>window.held.close());
  await expect(a.getByRole('alert',{name:'Almacenamiento local'})).toHaveCount(0);
  await a.setViewportSize({width:1440,height:1000});
  await a.getByText('Sincronizado',{exact:true}).waitFor();
  phase='dirty peer';
  const b=await newPage();await b.goto(`${base}/?resource=${task.id}`,{waitUntil:'domcontentloaded'});
  await b.getByLabel('Título',{exact:true}).fill('Second tab draft');
  await expect(b.getByLabel('Título',{exact:true})).toHaveValue('Second tab draft');
  phase='concurrent stale save';
  await a.goto(`${base}/?resource=${task.id}`,{waitUntil:'domcontentloaded'});
  await a.getByLabel('Título',{exact:true}).fill('First tab saved');
  await a.getByRole('button',{name:'Guardar cambios',exact:true}).click();
  const snapshot=async()=>(await(await context.request.get(base+`/api/workspaces/${ws}/resources`)).json()).resources;
  await expect.poll(async()=>(await snapshot()).find(r=>r.id===task.id).title).toBe('First tab saved');
  await expect(b.getByLabel('Título',{exact:true})).toHaveValue('Second tab draft');
  await b.getByRole('button',{name:'Guardar cambios',exact:true}).click();
  await expect.poll(async()=>(await openDatabase(a,userId,'pending')).some(p=>p.error&&p.resource.title==='Second tab draft')).toBe(true);
  assert.equal((await snapshot()).find(r=>r.id===task.id).title,'First tab saved');
  for (const page of [a,b]) await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  const otherWorkspace=await post('/workspaces',{name:`Other session scope ${Date.now()}`});
  await a.goto(`${base}/?view=tasks&workspace=${otherWorkspace.id}`,{waitUntil:'domcontentloaded'});
  await a.getByText('Sincronizado',{exact:true}).waitFor();
  await a.getByRole('button',{name:'Cerrar sesión',exact:true}).click();
  await expect(a.getByRole('alert')).toContainText('cambios pendientes de sincronizar');
  await b.getByRole('button',{name:'Usar la del servidor',exact:true}).click();
  await expect.poll(async()=>(await openDatabase(a,userId,'pending')).length).toBe(0);
  phase='closed draft';
  await openSection(a, 'Informes');
  await a.getByText('Personalizar panel y filtros',{exact:true}).click();
  await a.getByLabel('Nombre del panel',{exact:true}).fill('Retained dashboard draft');
  await a.getByText('Borrador del panel guardado en este dispositivo.',{exact:true}).waitFor();
  await openSection(a, 'Hoy');
  await a.getByText('Sincronizado',{exact:true}).waitFor();
  await a.getByRole('button',{name:'Cerrar sesión',exact:true}).click();
  await expect(a.getByRole('alert')).toContainText('borradores o comandos sin confirmar');
  phase='explicit retained sign-out';
  await a.getByRole('button',{name:'Conservar copias locales y cerrar sesión',exact:true}).click();
  for(const page of [a,b]) await page.getByRole('button',{name:'Entrar',exact:true}).waitFor();
  assert.equal(await a.evaluate(async userId=>(await indexedDB.databases()).some(db=>db.name===`kelvin-${userId}`),userId),true);
  await context.setOffline(true);await b.reload({waitUntil:'domcontentloaded'});await b.getByRole('button',{name:'Entrar',exact:true}).waitFor();await context.setOffline(false);
  await a.getByLabel('Correo electrónico',{exact:true}).fill('browser@example.test');
  await a.getByLabel('Contraseña',{exact:true}).fill('browser-test-password-long');
  await a.getByRole('button',{name:'Entrar',exact:true}).click();
  await a.getByRole('heading',{name:'Hoy',exact:true}).waitFor();
  await openSection(a, 'Informes');
  await a.getByText('Personalizar panel y filtros',{exact:true}).click();
  await expect(a.getByLabel('Nombre del panel',{exact:true})).toHaveValue('Retained dashboard draft');
  await a.getByRole('button',{name:'Restaurar configuración guardada',exact:true}).click();
  await expect.poll(async()=>(await openDatabase(a,userId,'keys')).filter(k=>String(k).startsWith('protected-draft:')).length).toBe(0);
  phase='document confirmation';
  const document=(await post(`/workspaces/${ws}/mutate`,{operationId:crypto.randomUUID(),id:crypto.randomUUID(),kind:'document',title:'Retained document',data:{},expectedVersion:0})).resource;
  await b.goto(`${base}/?resource=${document.id}`,{waitUntil:'domcontentloaded'});
  await b.locator('.tiptap').fill('Server confirmed text');
  await b.getByText('Guardado en el servidor',{exact:true}).waitFor();
  await context.setOffline(true);
  await b.locator('.tiptap').fill('Offline text must survive logout');
  await expect.poll(()=>b.evaluate(async({userId,documentId})=>{const db=await new Promise(resolve=>{const r=indexedDB.open(`kelvin-${userId}-document-${documentId}`,1);r.onsuccess=()=>resolve(r.result);});try{return await new Promise(resolve=>{const r=db.transaction('custom').objectStore('custom').get('unsynced');r.onsuccess=()=>resolve(r.result);});}finally{db.close();}},{userId,documentId:document.id})).toBe(1);
  await b.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  await context.setOffline(false);
  await openSection(a, 'Hoy');
  await a.getByText('Sincronizado',{exact:true}).waitFor();
  await a.getByRole('button',{name:'Cerrar sesión',exact:true}).click();
  await expect(a.getByRole('alert')).toContainText('documento sin confirmar');
  await b.goto(`${base}/?resource=${document.id}`,{waitUntil:'domcontentloaded'});
  await expect(b.locator('.tiptap')).toContainText('Offline text must survive logout');
  await b.getByText('Guardado en el servidor',{exact:true}).waitFor();
  await b.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  phase='logout';
  await openSection(a, 'Hoy');
  await a.getByText('Sincronizado',{exact:true}).waitFor();
  await a.getByRole('button',{name:'Cerrar sesión',exact:true}).click();
  for (const page of [a,b]) await page.getByRole('button',{name:'Entrar',exact:true}).waitFor();
  await expect.poll(()=>a.evaluate(async userId=>(await indexedDB.databases()).some(db=>db.name===`kelvin-${userId}`||db.name?.startsWith(`kelvin-${userId}-document-`)),userId)).toBe(false);
  assert.equal((await context.request.get(base+'/api/me')).status(),401);
  await context.setOffline(true);
  await b.reload({waitUntil:'domcontentloaded'});await b.getByRole('button',{name:'Entrar',exact:true}).waitFor();
  phase='external upgrade';
  const upgradeContext=await browser.newContext({storageState:'.local/browser-state.json',viewport:{width:1440,height:1000}});
  try {
    const current=await upgradeContext.newPage();current.on('pageerror',error=>errors.push(error.message));
    await current.goto(`${base}/?resource=${task.id}`,{waitUntil:'domcontentloaded'});
    await current.getByLabel('Título',{exact:true}).fill('Unsaved during version upgrade');
    const upgrader=await upgradeContext.newPage();await upgrader.goto(base+'/mark.svg');
    await upgrader.evaluate(async userId=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(`kelvin-${userId}`,3);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();},userId);
    // The warning stays outside the editor; the in-memory draft remains exportable.
    await expect(current.getByRole('alert',{name:'Almacenamiento local',includeHidden:true})).toContainText('Esta pestaña necesita actualizarse');
    await expect(current.getByLabel('Título',{exact:true})).toHaveValue('Unsaved during version upgrade');
    await current.screenshot({path:'docs/evidence/storage-upgraded-desktop.png'});
    await upgrader.goto(`${base}/?view=tasks&workspace=${ws}`,{waitUntil:'domcontentloaded'});
    await expect(upgrader.getByRole('alert',{name:'Almacenamiento local'})).toContainText('Esta pestaña necesita actualizarse');
  } finally {await upgradeContext.close();}
  assert.equal(errors.length,0,errors.join('\n'));
  await writeFile('docs/evidence/session-lifecycle-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),syntheticData:true,productionData:false,checks:{blockedUpgradeRecovery:true,externalUpgradePreservesDirtyDraft:true,futureDatabaseRefused:true,mobileStorageNotice:true,concurrentStaleSaveRetained:true,allWorkspaceOutboxProtection:true,closedDraftProtection:true,explicitRetainedLogout:true,retainedDraftRecoveredAfterAuthentication:true,unconfirmedDocumentProtection:true,documentReconnectDurability:true,crossTabLogout:true,userDatabaseDeleted:true,offlineSessionNotRestored:true},pageErrors:errors},null,2));
  console.info('Session lifecycle checks passed.');
} catch(error) {
  console.error('Failed phase:',phase);
  for(const [index,page] of pages.entries()) if(!page.isClosed()) {await page.screenshot({path:`.local/session-failure-${index}.png`,timeout:3000}).catch(()=>{});console.error(index,await page.locator('body').innerText().catch(()=>''));}
  throw error;
} finally {await context.setOffline(false);await browser.close();}
