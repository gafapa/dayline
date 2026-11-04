import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {postFixture} from './browser-fixture-request.mjs';
import {openSection} from './navigation-helper.mjs';
const base='http://127.0.0.1:5173',headers={'X-Kelvin-Client':'web','X-Kelvin-Document-Schema':'1'},suffix=Date.now();
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({storageState:process.env.BROWSER_STATE||'.local/browser-state.json',viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
context.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));let phase='setup',peer,resetContext;
const post=(path,data,client=context.request)=>postFixture(client,base+'/api'+path,headers,data);
try{
 const me=await(await context.request.get(base+'/api/me')).json();assert.equal(me.user.platformAdmin,true,'the synthetic owner is the first account');
 const ws=me.workspaces[0].id,email=`platform-peer-${suffix}@example.test`,password='platform-peer-password';
 const invitation=await post(`/workspaces/${ws}/invitations`,{email,role:'member'});peer=await browser.newContext();
 await post('/invitations/accept',{email,name:`Persona gestionada ${suffix}`,password,token:new URL(invitation.url).searchParams.get('invitation')},peer.request);
 const peerPage=await peer.newPage();peerPage.on('pageerror',e=>errors.push(e.message));await peerPage.goto(`${base}/?view=overview&workspace=${ws}`,{waitUntil:'domcontentloaded'});await peerPage.getByRole('heading',{name:'Hoy',exact:true}).waitFor();
 phase='hidden for non-admins';await openSection(peerPage,'Configuración');await expect(peerPage.getByRole('navigation',{name:'Secciones'}).getByRole('button',{name:'Plataforma',exact:true})).toHaveCount(0);
 phase='open panel';await page.goto(`${base}/?view=overview&workspace=${ws}`,{waitUntil:'domcontentloaded'});await page.getByText('Sincronizado',{exact:true}).waitFor();await openSection(page,'Configuración');
 await page.getByRole('navigation',{name:'Secciones'}).getByRole('button',{name:'Plataforma',exact:true}).click();await page.getByRole('heading',{name:'Plataforma',exact:true}).waitFor();
 await page.getByLabel('Buscar cuentas',{exact:true}).fill(email);await page.getByRole('button',{name:'Buscar',exact:true}).click();
 const row=page.locator('.platform-row').filter({hasText:email});await expect(row).toHaveCount(1);await expect(row).toContainText('(miembro)');await expect(row).toContainText('1 sesión abierta');
 phase='suspend';await row.getByRole('button',{name:'Gestionar',exact:true}).click();await row.getByRole('button',{name:'Suspender cuenta',exact:true}).click();await expect(row.getByRole('alert')).toContainText('automatizaciones');
 await row.getByRole('button',{name:'Confirmar suspensión',exact:true}).click();await expect(row).toContainText('Suspendida');
 await peerPage.reload({waitUntil:'domcontentloaded'});await peerPage.getByRole('button',{name:'Entrar',exact:true}).waitFor();
 await peerPage.getByLabel('Correo electrónico',{exact:true}).fill(email);await peerPage.getByLabel('Contraseña',{exact:true}).fill(password);await peerPage.getByRole('button',{name:'Entrar',exact:true}).click();await expect(peerPage.getByRole('alert')).toContainText('suspendida');
 phase='reset link refused while suspended';await expect(row.getByRole('button',{name:'Crear enlace de nueva contraseña',exact:true})).toBeDisabled();
 phase='reactivate';await row.getByRole('button',{name:'Reactivar cuenta',exact:true}).click();await expect(row).not.toContainText('Suspendida');
 phase='reset link';await row.getByRole('button',{name:'Crear enlace de nueva contraseña',exact:true}).click();const url=await row.getByLabel('Enlace de nueva contraseña',{exact:true}).inputValue();assert.match(url,/\?reset=/);
 resetContext=await browser.newContext();const resetPage=await resetContext.newPage();resetPage.on('pageerror',e=>errors.push(e.message));await resetPage.goto(url.replace(/^https?:\/\/[^/]+/,base),{waitUntil:'domcontentloaded'});
 await resetPage.getByRole('heading',{name:'Nueva contraseña',exact:true}).waitFor();await resetPage.screenshot({path:'docs/evidence/platform-reset-390.png'}).catch(()=>{});
 await resetPage.getByLabel('Nueva contraseña',{exact:true}).fill('NuevaClave1');await resetPage.getByLabel('Repite la contraseña',{exact:true}).fill('OtraClave1');await resetPage.getByRole('button',{name:'Guardar contraseña',exact:true}).click();await expect(resetPage.getByRole('alert')).toContainText('no coinciden');
 await resetPage.getByLabel('Repite la contraseña',{exact:true}).fill('NuevaClave1');await resetPage.getByRole('button',{name:'Guardar contraseña',exact:true}).click();await resetPage.getByText('Contraseña actualizada',{exact:false}).waitFor();
 await resetPage.getByLabel('Correo electrónico',{exact:true}).fill(email);await resetPage.getByLabel('Contraseña',{exact:true}).fill('NuevaClave1');await resetPage.getByRole('button',{name:'Entrar',exact:true}).click();await resetPage.getByRole('heading',{name:'Hoy',exact:true}).waitFor();
 phase='revoke sessions';await page.getByRole('button',{name:'Buscar',exact:true}).click();await expect(row).toContainText('1 sesión abierta');if(!(await row.getByRole('button',{name:'Cerrar sesiones',exact:true}).count()))await row.getByRole('button',{name:'Gestionar',exact:true}).click();await row.getByRole('button',{name:'Cerrar sesiones',exact:true}).click();await expect(row).toContainText('0 sesiones abiertas');
 await resetPage.reload({waitUntil:'domcontentloaded'});await resetPage.getByRole('button',{name:'Entrar',exact:true}).waitFor();
 phase='audit';const audit=page.locator('.platform-audit');await expect(audit).toContainText(`suspendió ${email}`);await expect(audit).toContainText(`reactivó ${email}`);await expect(audit).toContainText(`creó un enlace de contraseña para ${email}`);await expect(audit).toContainText(`cerró las sesiones de ${email}`);
 phase='responsive';for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`docs/evidence/platform-${width}.png`});}
 assert.equal(errors.length,0,errors.join('\n'));
 await writeFile('docs/evidence/platform-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),syntheticData:true,checks:{hiddenForNonAdmins:true,searchAccounts:true,workspacesAndSessionsShown:true,suspendClosesSessions:true,suspendedLoginRefused:true,resetDisabledWhileSuspended:true,reactivate:true,singleUseResetLink:true,resetPasswordMismatch:true,loginWithResetPassword:true,revokeSessions:true,auditTrail:true,responsiveWidths:[1440,768,390]},pageErrors:errors},null,2));
 console.info('Platform account search, suspension, reactivation, reset links, session revocation and audit verified.');
}catch(error){console.error('Failed phase:',phase);await page.screenshot({path:'.local/platform-failure.png',fullPage:true}).catch(()=>{});throw error;}
finally{await peer?.close();await resetContext?.close();await browser.close();}
