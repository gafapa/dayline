import { chromium } from '@playwright/test';
import { openSection } from './navigation-helper.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.env.TEST_URL||'http://127.0.0.1:5173';
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},...(process.env.BROWSER_STATE?{storageState:process.env.BROWSER_STATE}:{})});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir('docs/evidence',{recursive:true});
try {
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const existingSession=(await page.request.get(`${base}/api/me`)).ok();
  if(!existingSession){
  await page.getByRole('heading',{name:/Te damos la bienvenida|Vuelve a tu espacio/}).waitFor();
  const bootstrap=await page.request.get(`${base}/api/bootstrap`);const state=await bootstrap.json();
  if(state.setupRequired) {
    await page.getByText('Base de datos',{exact:false}).first().waitFor();await page.screenshot({path:'docs/evidence/setup-server.png'});
    await page.getByRole('button',{name:'Empezar',exact:true}).click();
    await page.getByLabel('Tu nombre',{exact:true}).fill('Equipo de pruebas');
    await page.getByLabel('Correo electrónico',{exact:true}).fill('browser@example.test');
    await page.getByLabel('Contraseña',{exact:true}).fill('browser-test-password-long');
    await page.getByLabel('Repite la contraseña',{exact:true}).fill('otra-password-distinta');
    await page.getByRole('button',{name:'Continuar',exact:true}).click();await page.getByRole('alert').filter({hasText:'no coinciden'}).waitFor();
    await page.getByLabel('Repite la contraseña',{exact:true}).fill('browser-test-password-long');
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByLabel('Nombre del espacio',{exact:true}).fill('Laboratorio de verificación');
    await page.getByRole('button',{name:'Crear espacio',exact:true}).click();
    await page.getByRole('heading',{name:'Todo listo'}).waitFor();await page.screenshot({path:'docs/evidence/setup-done.png'});
    await page.getByRole('button',{name:'Ir a Hoy',exact:true}).click();
  } else {
    await page.getByLabel('Correo electrónico',{exact:true}).fill('browser@example.test');
    await page.getByLabel('Contraseña',{exact:true}).fill('browser-test-password-long');
    await page.getByRole('button',{name:'Entrar',exact:true}).click();
  }
  }
  await page.getByRole('heading',{name:'Hoy',exact:true}).waitFor();
  await page.screenshot({path:'docs/evidence/overview-empty-desktop.png',fullPage:true});
  const suffix=Date.now();const projectTitle=`Verificación de entrega ${suffix}`;
  await openSection(page, 'Proyectos');
  await page.getByRole('button',{name:'Nuevo proyecto',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.getByLabel('Título',{exact:true}).fill(projectTitle);await dialog.getByLabel('Descripción',{exact:true}).fill('Datos sintéticos para comprobar persistencia, permisos y presentación.');await dialog.getByRole('button',{name:'Crear proyecto',exact:true}).click();
  await page.locator('.resource-dialog').waitFor();await page.locator('.resource-dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.getByRole('button',{name:projectTitle,exact:false}).first().click();
  await page.getByRole('button',{name:'Nueva tarea',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Título',{exact:true}).fill('Comprobar guardado y sincronización');await dialog.getByLabel('Responsable',{exact:true}).selectOption({label:'Equipo de pruebas'});await dialog.getByRole('button',{name:'Crear tarea',exact:true}).click();
  await page.locator('.resource-dialog').waitFor();await page.locator('.resource-dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  await openSection(page, 'Documentos');await page.getByRole('button',{name:'Nuevo documento',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Título',{exact:true}).fill(`Decisiones del equipo ${suffix}`);await dialog.getByRole('button',{name:'Crear documento',exact:true}).click();
  const editor=page.locator('.tiptap');await editor.waitFor();await editor.fill('Una decisión compartida conserva el contexto del proyecto.');
  await page.getByText('Guardado en el servidor',{exact:true}).waitFor({timeout:25000});
  await page.screenshot({path:'docs/evidence/document-desktop.png',fullPage:true});
  await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  await openSection(page, 'Hoy');
  await page.screenshot({path:'docs/evidence/overview-desktop.png',fullPage:true});
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Hoy',exact:true}).waitFor();
  await page.getByRole('button',{name:new RegExp(`Decisiones del equipo ${suffix}`)}).click();await page.locator('.tiptap').getByText('Una decisión compartida conserva el contexto del proyecto.',{exact:true}).waitFor();await page.getByText('Guardado en el servidor',{exact:true}).waitFor();
  const second=await context.newPage();await second.goto(base,{waitUntil:'domcontentloaded'});await openSection(second, 'Documentos');await second.getByRole('button',{name:new RegExp(`Decisiones del equipo ${suffix}`)}).click();await second.locator('.tiptap').waitFor();
  await page.locator('.tiptap').fill('Una decisión compartida conserva el contexto del proyecto. Edición desde la primera sesión.');await second.locator('.tiptap').getByText(/Edición desde la primera sesión/).waitFor();await page.getByText('Guardado en el servidor',{exact:true}).waitFor();await page.locator('.tiptap').press('Control+End');await page.locator('.tiptap').press('Backspace');await page.getByText('Guardado en el servidor',{exact:true}).waitFor();await second.close();
  await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'docs/evidence/overview-mobile.png',fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw new Error('Mobile horizontal overflow');
  await page.getByRole('button',{name:'Abrir navegación',exact:true}).click();await openSection(page, 'Todas las tareas');
  await page.screenshot({path:'docs/evidence/tasks-mobile.png',fullPage:true});
  await context.storageState({path:'.local/browser-state.json'});
  await writeFile('docs/evidence/browser-check.json',JSON.stringify({verifiedAt:new Date().toISOString(),base,syntheticData:true,checks:{login:!existingSession,sessionAuthenticated:true,projectCreation:true,taskCreation:true,documentDurability:true,collaborativePropagation:true,deleteOnlyDurability:true,mobileOverflow:overflow},pageErrors:errors},null,2));
  if(errors.length)throw new Error(errors.join('\n'));
  console.info('Browser checks passed: authentication, project/task creation, document durability, collaboration and mobile layout.');
} catch(error) {
  await page.screenshot({path:'docs/evidence/browser-failure.png',fullPage:true});
  console.error('Visible failure state:',await page.locator('body').innerText());
  console.error('Page errors:',errors);
  throw error;
} finally {await browser.close();}
