// Opens an app page through the grouped sidebar and its section tabs.
const groups = {
  Hoy: ['Hoy', 'Recordatorios'],
  Bandeja: ['Bandeja'],
  Tareas: ['Mis tareas', 'Todas las tareas', 'Calendario'],
  Proyectos: ['Proyectos'],
  Documentos: ['Documentos', 'Mis notas', 'Plantillas'],
  Planificar: ['Sprints', 'Hoja de ruta', 'Informes', 'Tiempo'],
};
const settings = ['Configuración', 'Espacios', 'Equipo', 'Actividad', 'Asistente IA', 'Papelera'];
const legacy = { 'Vista general': 'Hoy', 'Planificación': 'Hoja de ruta', 'Bandeja de entrada': 'Bandeja' };
export async function openSection(page, requested) {
  const name = legacy[requested] || requested;
  if (settings.includes(name)) {
    await page.locator('.sidebar-bottom').getByRole('button', { name: 'Configuración', exact: true }).click();
    if (name === 'Configuración') return;
  } else {
    const group = Object.entries(groups).find(([, pages]) => pages.includes(name))?.[0] || name;
    const sidebar = page.getByRole('navigation', { name: 'Principal' });
    await sidebar.getByRole('button', { name: new RegExp(`^${group}( \\d+)?$`) }).click();
    if (group === name || groups[group]?.[0] === name) return;
  }
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name, exact: true }).click();
}
