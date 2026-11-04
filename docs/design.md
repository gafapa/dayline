# Interface direction

Style: Framed sheet, seed 94022767. No redraws. The warm stone frame and Kelvin's green mark form the product face; document-to-task-to-sprint continuity is the signature element. IBM Plex Sans is served locally.

The initial account has no fabricated tasks, collaborators, metrics or projects. All displayed counts derive from persisted workspace resources. Empty states offer the real next action.

## Daily-work layout (0.18)

The sidebar has six destinations: **Hoy**, **Bandeja**, **Tareas**, **Proyectos**, **Documentos** and **Planificar**, followed by favorite (or recent) projects and **Configuración**. Related pages are section tabs at the top of the sheet instead of sidebar entries:

| Destination | Section tabs |
| --- | --- |
| Hoy | Hoy, Recordatorios |
| Tareas | Mis tareas, Todas las tareas, Calendario |
| Documentos | Documentos, Mis notas, Plantillas |
| Planificar | Sprints, Hoja de ruta, Informes, Tiempo |
| Configuración | Configuración, Equipo, Actividad, Asistente IA, Papelera |

Page URLs are unchanged. Page subtitles and the decorative footer were removed. **Hoy** replaces the overview's workspace totals with the signed-in person's overdue, due-today, in-progress and next-seven-day tasks (one-click completion), the running clock and time logged today, unread inbox items, today's reminders, the active sprint and recently edited documents. The approved mockup is the Design canvas "Kelvin Organizer · Mi día".

## Screen questions

- Hoy: what do I need to do or answer today?
- Projects: what outcomes are currently being pursued?
- Tasks: what work needs to move forward?
- Documents: where is the context for the work?
- Sprints: what goal is the team working toward, and what has been completed?
- Settings: what access, appearance, provider and data preferences apply?

## Verification

The browser checks in `scripts/` cover every main screen at 1440, 768 and 390 pixels with synthetic data, assert there is no horizontal overflow and save screenshots under the ignored `docs/evidence/` folder. Touch targets are at least 44 pixels on phones.
