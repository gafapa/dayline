import {chromium,expect} from '@playwright/test';
import {writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'msedge',headless:true});const c=await browser.newContext({storageState:'.local/browser-state.json',viewport:{width:1440,height:1000},acceptDownloads:true});const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
 const me=await(await c.request.get('http://127.0.0.1:5173/api/me')).json();const ws=me.workspaces[0].id;const data=await(await c.request.get(`http://127.0.0.1:5173/api/workspaces/${ws}/resources`)).json();const task=data.resources.find(r=>r.kind==='task'&&!r.deleted_at);assert.ok(task);
 await p.goto(`http://127.0.0.1:5173/?resource=${task.id}`,{waitUntil:'domcontentloaded'});await p.getByLabel('Título',{exact:true}).fill('Preserved during database upgrade');
 const q=await c.newPage();await q.goto('http://127.0.0.1:5173/mark.svg');await q.evaluate(async userId=>{const d=await new Promise((resolve,reject)=>{const r=indexedDB.open(`kelvin-${userId}`,3);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});d.close();},me.user.id);
 await expect(p.getByRole('alert',{name:'Almacenamiento local'})).toContainText('Esta pestaña necesita actualizarse');await p.screenshot({path:'docs/evidence/storage-upgraded-desktop.png'});
 await p.getByRole('button',{name:'Seguir revisando mis cambios',exact:true}).click();await expect(p.getByRole('alert',{name:'Almacenamiento local'})).toHaveCount(0);await expect(p.getByLabel('Título',{exact:true})).toHaveValue('Preserved during database upgrade');
 const downloaded=p.waitForEvent('download');await p.getByRole('button',{name:'Exportar',exact:true}).click();const download=await downloaded;await download.saveAs('.local/upgraded-draft-export.json');assert.equal(JSON.parse(await readFile('.local/upgraded-draft-export.json','utf8')).title,'Preserved during database upgrade');assert.equal(errors.length,0,errors.join('\n'));
 await writeFile('docs/evidence/storage-notice-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),syntheticData:true,finalBuildVersion:'0.11.1',outdatedNoticeAccessibleInsideDialog:true,dismissalPreservesDraft:true,retainedDraftExported:true,pageErrors:errors},null,2));console.info('Outdated storage notice, retained form and export verified.');
}finally{await browser.close();}
