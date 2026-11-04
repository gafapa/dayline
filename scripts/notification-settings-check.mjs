import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:5173',headers={'X-Kelvin-Client':'web','X-Kelvin-Document-Schema':'1'};
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({storageState:process.env.BROWSER_STATE||'.local/browser-state.json',viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
let original,phase='profile';
const status=async()=>{const response=await context.request.get(base+'/api/notification-settings');if(!response.ok())throw new Error('Settings read failed');return response.json();};
const form=()=>page.getByRole('region',{name:'Preferencias de notificaciones',exact:true});
const open=async(workspace)=>{await page.goto(`${base}/?view=settings&workspace=${workspace}`,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Notificaciones',exact:true}).click();await form().waitFor();};
try{
 const profile=await(await context.request.get(base+'/api/me')).json(),workspace=profile.workspaces[0].id;original=await status();
 phase='draft';await open(workspace);await form().getByLabel('Asignaciones',{exact:true}).uncheck();await form().getByLabel('Aplazar durante las horas de silencio',{exact:true}).check();await form().getByLabel('Zona horaria del silencio',{exact:true}).fill('Europe/');await page.getByText('Borrador de preferencias guardado en este dispositivo.',{exact:true}).waitFor();
 phase='offline draft';await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Notificaciones',exact:true}).click();await form().waitFor();await page.waitForFunction(()=>document.querySelector('.notification-settings input[maxlength="80"]')?.value==='Europe/');
 if(await form().getByLabel('Asignaciones',{exact:true}).isChecked())throw new Error('Offline category draft lost');
 await form().getByRole('button',{name:'Guardar preferencias de notificaciones',exact:true}).click();await page.getByRole('alert').filter({hasText:'Sin conexión'}).waitFor();
 await form().getByLabel('Zona horaria del silencio',{exact:true}).fill('Europe/Madrid');await page.getByText('Borrador de preferencias guardado en este dispositivo.',{exact:true}).waitFor();await context.setOffline(false);await page.getByText('Sincronizado',{exact:true}).waitFor();
 phase='response loss';let lost=false;await context.route('**/api/notification-settings',async route=>{if(route.request().method()==='PUT'&&!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
 await form().getByRole('button',{name:'Guardar preferencias de notificaciones',exact:true}).click();await form().getByRole('alert').waitFor();if(!lost||(await status()).settings.categories.assignment)throw new Error('Committed response-loss fixture did not persist');
 await context.unroute('**/api/notification-settings');await form().getByRole('button',{name:'Guardar preferencias de notificaciones',exact:true}).click();await page.getByText('Preferencias de notificaciones guardadas.',{exact:true}).waitFor();
 phase='concurrent preferences';await form().getByLabel('Elementos que sigues',{exact:true}).uncheck();const concurrent=await status();concurrent.settings.categories.review=false;const changed=await context.request.put(base+'/api/notification-settings',{headers,data:{settings:concurrent.settings,expectedVersion:concurrent.version}});if(!changed.ok())throw new Error('Concurrent preference fixture failed');
 await form().getByRole('button',{name:'Guardar preferencias de notificaciones',exact:true}).click();await form().getByRole('alert').filter({hasText:'otra sesión'}).waitFor();if(await form().getByLabel('Elementos que sigues',{exact:true}).isChecked())throw new Error('Conflict discarded the local draft');
 await form().getByRole('button',{name:'Descartar borrador y cargar del servidor',exact:true}).click();await page.getByText('Preferencias del servidor cargadas. Se ha descartado el borrador local.',{exact:true}).waitFor();if(await form().getByLabel('Solicitudes de revisión',{exact:true}).isChecked()||!await form().getByLabel('Elementos que sigues',{exact:true}).isChecked())throw new Error('Explicit server reload did not restore current settings');
 phase='responsive';await mkdir('docs/evidence',{recursive:true});for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>{window.scrollTo(0,0);return document.fonts.ready;});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(`Horizontal overflow at ${width}`);await page.screenshot({path:`docs/evidence/notification-settings-${width}.png`,fullPage:true});}
 if(errors.length)throw new Error('Browser errors occurred');
 await writeFile('docs/evidence/notification-settings-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),syntheticData:true,checks:{categoryPreferences:true,quietSchedule:true,offlineDraftReload:true,incompleteTimeZoneDraftRetained:true,offlineSaveRefusedWithoutDiscard:true,lostResponseReplay:true,concurrentSaveConflict:true,explicitServerReload:true,responsiveWidths:[1440,768,390]},pageErrors:errors},null,2));
 console.info('Notification preferences, incomplete offline drafts, lost-response replay and concurrent saves verified.');
}catch(error){console.error('Failed phase:',phase);throw error;}finally{
 await context.setOffline(false);await context.unroute('**/api/notification-settings').catch(()=>{});
 if(original){const current=await status();const restored=await context.request.put(base+'/api/notification-settings',{headers,data:{settings:original.settings,expectedVersion:current.version}});if(!restored.ok())throw new Error('Synthetic account preferences were not restored');}
 await browser.close();
}
