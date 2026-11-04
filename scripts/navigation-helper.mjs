// Opens an app page through the sidebar (Mi trabajo · Proyectos · Equipo) and its section tabs.
const groups = {
  Hoy: ['Hoy', 'Recordatorios'],
  Bandeja: ['Bandeja'],
  'Mis tareas': ['Mis tareas'],
  'Mis notas': ['Mis notas'],
  Tareas: ['Todas las tareas', 'Calendario'],
  Documentos: ['Documentos', 'Plantillas'],
  'Planificación': ['Sprints', 'Hoja de ruta'],
  'Informes y tiempo': ['Informes', 'Tiempo'],
  'Todos los proyectos': ['Proyectos'],
};
const settings = ['Configuración', 'Espacios', 'Equipo', 'Actividad', 'Asistente IA', 'Papelera'];
const legacy = { 'Vista general': 'Hoy', 'Planificación': 'Hoja de ruta', 'Bandeja de entrada': 'Bandeja', 'Notas': 'Mis notas' };
export async function openSection(page, requested) {
  const name = legacy[requested] || requested;
  if (settings.includes(name)) {
    await page.locator('.sidebar-bottom').getByRole('button', { name: 'Configuración', exact: true }).click();
    if (name === 'Configuración') return;
  } else {
    const group = Object.entries(groups).find(([, pages]) => pages.includes(name))?.[0] || name;
    const sidebar = page.getByRole('navigation', { name: 'Principal' });
    await sidebar.getByRole('button', { name: new RegExp(`^${group}( \d+)?$`) }).click();
    if (groups[group]?.[0] === name || group === name) return;
  }
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name, exact: true }).click();
}
