import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {postFixture} from './browser-fixture-request.mjs';
import {openSection} from './navigation-helper.mjs';
const base='http://127.0.0.1:5173',headers={'X-Kelvin-Client':'web','X-Kelvin-Document-Schema':'1'},suffix=Date.now();
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({storageState:process.env.BROWSER_STATE||'.local/browser-state.json',viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
context.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));let phase='setup',hiddenBefore;
const post=(path,data)=>postFixture(context.request,base+'/api'+path,headers,data);
const list=async()=>(await(await context.request.get(base+'/api/workspaces')).json()).workspaces;
try{
 hiddenBefore=(await(await context.request.get(base+'/api/me')).json()).preferences?.hiddenWorkspaces||[];
 const first=await post('/workspaces',{name:`Espacio principal ${suffix}`}),second=await post('/workspaces',{name:`Espacio secundario ${suffix}`});
 await page.goto(`${base}/?view=overview&workspace=${first.id}`,{waitUntil:'domcontentloaded'});await page.getByText('Sincronizado',{exact:true}).waitFor();
 phase='open manager';await openSection(page,'Espacios');await page.getByRole('heading',{name:'Espacios',exact:true}).waitFor();
 const row=name=>page.locator('.workspace-row').filter({has:page.getByLabel(`Nombre de ${name}`,{exact:true})});
 await expect(row(second.name)).toContainText('Administración · 1 persona');
 phase='last admin cannot leave';await expect(row(second.name).getByRole('button',{name:'Salir del espacio',exact:true})).toBeDisabled();await expect(row(second.name)).toContainText('Única administración');
 phase='rename';const renamed=`Espacio renombrado ${suffix}`;await page.getByLabel(`Nombre de ${second.name}`,{exact:true}).fill(renamed);await row(second.name).getByRole('button',{name:'Guardar nombre',exact:true}).click();
 await expect.poll(async()=>(await list()).find(w=>w.id===second.id)?.name).toBe(renamed);await expect(page.getByLabel('Espacio de trabajo',{exact:true}).locator('option',{hasText:renamed})).toHaveCount(1);
 phase='hide';await row(renamed).getByRole('button',{name:'Ocultar del selector',exact:true}).click();await expect(row(renamed)).toContainText('Oculto en el selector');await expect(page.getByLabel('Espacio de trabajo',{exact:true}).locator('option',{hasText:renamed})).toHaveCount(0);
 await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Espacios',exact:true}).waitFor();await expect(page.getByLabel('Espacio de trabajo',{exact:true}).locator('option',{hasText:renamed})).toHaveCount(0);
 phase='open hidden';await row(renamed).getByRole('button',{name:'Abrir',exact:true}).click();await expect(page.getByLabel('Espacio de trabajo',{exact:true})).toHaveValue(second.id);await expect(page.getByLabel('Espacio de trabajo',{exact:true}).locator('option',{hasText:renamed})).toHaveCount(1);
 phase='show';await openSection(page,'Espacios');await row(renamed).getByRole('button',{name:'Mostrar en el selector',exact:true}).click();await expect(row(renamed)).not.toContainText('Oculto en el selector');
 phase='create from manager';const created=`Espacio desde gestión ${suffix}`;await page.getByLabel('Nombre del espacio',{exact:true}).fill(created);await page.getByRole('button',{name:'Crear espacio',exact:true}).click();
 await expect.poll(async()=>(await list()).some(w=>w.name===created)).toBe(true);const createdId=(await list()).find(w=>w.name===created).id;await expect(page.getByLabel('Espacio de trabajo',{exact:true})).toHaveValue(createdId);
 phase='responsive';await openSection(page,'Espacios');for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`docs/evidence/workspaces-${width}.png`});}
 assert.equal(errors.length,0,errors.join('\n'));
 await writeFile('docs/evidence/workspaces-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),syntheticData:true,checks:{listRolesAndMembers:true,lastAdminCannotLeave:true,renameUpdatesSelector:true,hideSurvivesReload:true,openHiddenWorkspace:true,showAgain:true,createAndOpen:true,responsiveWidths:[1440,768,390]},pageErrors:errors},null,2));
 console.info('Workspace listing, rename, hide/show, open and creation verified.');
}catch(error){console.error('Failed phase:',phase);await page.screenshot({path:'.local/workspaces-failure.png',fullPage:true}).catch(()=>{});throw error;}
finally{if(hiddenBefore)await context.request.put(base+'/api/preferences',{headers,data:{hiddenWorkspaces:hiddenBefore}}).catch(()=>{});await browser.close();}
