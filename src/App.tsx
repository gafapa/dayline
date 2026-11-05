import { authorizeLocalUser } from "./local-lifecycle";
import { DragProvider, useDrag, useDrop } from "./dnd";
import { useLocalGuard } from "./useLocalGuard";
import { coordinateLocalSession, signOutEverywhereLocal, LocalWorkRetained } from "./session-coordination";
import { isStructure, structureParent } from "../shared/hierarchy";
import { applyFieldDefaults, fieldDefaults, fieldValueError } from "../shared/custom-fields";
import { resolveNavigation } from "./resolve-navigation";
import { navigationEvent, localResourceLocation } from "./navigation";
import { readAppRoute, pageHref, type AppPage } from "../shared/navigation";
import { Modal } from "./components/Primitives";
import { isDelivery } from "../shared/delivery";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, CalendarDays, Check, ChevronDown, ChevronRight, CircleCheck, FileText, Flag, FolderKanban, Inbox, LayoutDashboard, ListFilter, LoaderCircle, LogOut, Menu, MoreHorizontal, Plus, Search, Settings, Sparkles, Star, Target, Trash2, Users, WifiOff, X, History, Layers, Clock3, Sun, NotebookPen, ListTodo, BarChart3 } from "lucide-react";
import { api, ApiError, send } from "./api";
import { cacheSnapshot, beginSnapshotRead, flushOutbox, localSnapshot, pendingOperations, queueMutation, resolveConflict, rememberSession, rememberedSession, forgetSession } from "./storage";
import { kindLabels, sprintStats, type Resource, type ResourceKind, type User, type Workspace } from "../shared/model";
const CollaborativeEditor = lazy(() => import("./CollaborativeEditor"));
const ProjectStructure = lazy(() => import("./ProjectStructure"));
const CustomFieldAdmin = lazy(() => import("./CustomFieldAdmin"));
const WorkflowAdmin = lazy(() => import("./WorkflowAdmin"));
const WorkspaceManager = lazy(() => import("./WorkspaceManager"));
const PlatformAdmin = lazy(() => import("./PlatformAdmin"));
const Setup = lazy(() => import("./Setup"));
const InboxTriage = lazy(() => import("./Inbox"));
const CommandPalette = lazy(() => import("./CommandPalette"));
import Today from "./Today";
import { normalizeTaskState } from "../shared/workflow";
import { Auth } from "./Auth";
import { Calendar } from "./Calendar";
import { CreateDialog, ResourceDialog } from "./ResourceDialog";
import { Team } from "./TeamSettings";
import { Activity } from "./ActivityLog";
import { SettingsView } from "./SettingsView";
import { AIView } from "./AIAssistant";
import { SearchField, Empty, download, dateText } from "./ui-common";
type Page = AppPage;
const navItems: [Page, string, any][] = [
  ["overview", "Hoy", LayoutDashboard],
  ["my_tasks", "Mis tareas", CircleCheck],
  ["inbox", "Bandeja", Inbox],
  ["notes", "Mis notas", FileText],
  ["reminders", "Recordatorios", Bell],
  ["projects", "Proyectos", FolderKanban],
  ["tasks", "Todas las tareas", Layers],
  ["documents", "Documentos", FileText],
  ["sprints", "Sprints", Target],
  ["calendar", "Calendario", CalendarDays],
  ["planning", "Hoja de ruta", Flag],
  ["templates", "Plantillas", FileText],
  ["reports", "Informes", ListFilter],
  ["time", "Tiempo", Clock3],
  ["team", "Equipo", Users],
  ["activity", "Actividad", History],
  ["ai", "Asistente IA", Sparkles],
];
const pageTitles: Record<string, string> = {
  ...Object.fromEntries(navItems.map(([key, label]) => [key, label])),
  settings: "Configuración",
  workspaces: "Espacios",
  platform: "Plataforma",
  trash: "Papelera",
};
/** Sidebar destinations: personal work, then team-wide views. Each groups pages shown as tabs. */
const navGroups: {
  label: string;
  icon: any;
  pages: Page[];
  section: "mine" | "team";
}[] = [
  { label: "Hoy", icon: Sun, pages: ["overview", "reminders"], section: "mine" },
  { label: "Bandeja", icon: Inbox, pages: ["inbox"], section: "mine" },
  { label: "Mis tareas", icon: CircleCheck, pages: ["my_tasks"], section: "mine" },
  { label: "Mis notas", icon: NotebookPen, pages: ["notes"], section: "mine" },
  { label: "Tareas", icon: ListTodo, pages: ["tasks", "calendar"], section: "team" },
  { label: "Documentos", icon: FileText, pages: ["documents", "templates"], section: "team" },
  { label: "Planificación", icon: Flag, pages: ["sprints", "planning"], section: "team" },
  { label: "Informes y tiempo", icon: BarChart3, pages: ["reports", "time"], section: "team" },
];
/** Views shown as tabs inside a project page, each filtered to that project. */
const projectTabs: [Page, string][] = [
  ["tasks", "Tareas"],
  ["calendar", "Calendario"],
  ["documents", "Documentos"],
  ["planning", "Hoja de ruta"],
];
const settingsPages: Page[] = [
  "settings",
  "workspaces",
  "team",
  "activity",
  "ai",
  "trash",
  "platform",
];
/** Settings grouped by scope: your account, this workspace, the whole platform. */
const settingsGroups: [string, Page[]][] = [
  ["Tu cuenta", ["settings"]],
  ["Espacio", ["team", "activity", "ai", "trash"]],
  ["Plataforma", ["workspaces", "platform"]],
];
const pageGroup = (page: Page) =>
  navGroups.find((group) => group.pages.includes(page))?.pages ||
  (settingsPages.includes(page) ? settingsPages : [page]);

const DeliveryWorkspace = lazy(() => import("./DeliveryWorkspace"));
const Reports = lazy(() => import("./Reports"));
const TimeTracking = lazy(() => import("./TimeTracking"));
const PrivateNotes = lazy(() => import("./PrivateNotes"));
const QuickCapture = lazy(() => import("./QuickCapture"));
const Reminders = lazy(() => import("./Reminders"));
const NotificationSettings = lazy(() => import("./NotificationSettings"));
const TaskCollection = lazy(() => import("./TaskCollection"));
const TemplateLibrary = lazy(() => import("./TemplateLibrary"));
const SprintWorkspace = lazy(() => import("./SprintWorkspace"));
export default function App() {
  const loadedScope = useRef("");
  const [boot, setBoot] = useState<any>(),
    [user, setUser] = useState<User | null>(null),
    [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [workspaceId, setWorkspaceId] = useState("");
  const [resourceState, setResources] = useState<Resource[]>([]),
    [memberState, setMembers] = useState<any[]>([]),
    [preferences, setPreferences] = useState<any>({});
  const scopeKey = `${user?.id || ""}:${workspaceId}`;
  const resources = loadedScope.current === scopeKey ? resourceState : [],
    members = loadedScope.current === scopeKey ? memberState : [];
  const [page, setPage] = useState<Page>("overview"),
    [projectId, setProjectId] = useState<string | null>(null),
    [selected, setSelected] = useState<Resource | null>(null),
    [creating, setCreating] = useState<ResourceKind | null>(null);
  const [deliveryFocus, setDeliveryFocus] = useState<string | null>(null);
  const [dashboardFocus, setDashboardFocus] = useState<string | null>(null);
  const [timeFocus, setTimeFocusState] = useState<string | null>(null);
  const [timeCreationRequested, setTimeCreationRequested] = useState(false);
  const [reminderFocus, setReminderFocus] = useState<string | null>(null);
  const [reminderTarget, setReminderTarget] = useState<string | null>(null);
  const [reminderCreationRequested, setReminderCreationRequested] =
    useState(false);
  const resetReminders = () => {
    setReminderFocus(null);
    setReminderTarget(null);
    setReminderCreationRequested(false);
  };
  const setTimeFocus = (id: string | null) => {
    setTimeFocusState(id);
    setTimeCreationRequested(false);
  };
  const [projectLayout, setProjectLayout] = useState<"cards" | "structure">(
    "cards",
  );
  const [hierarchyFocusId, setHierarchyFocusId] = useState<string | null>(null);
  const [configuringWorkflow, setConfiguringWorkflow] =
    useState<Resource | null>(null);
  const [configuringFields, setConfiguringFields] = useState<Resource | null>(
    null,
  );
  const [query, setQuery] = useState(""),
    [menu, setMenu] = useState(false),
    [command, setCommand] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pendingState, setPending] = useState<any[]>([]),
    [syncing, setSyncing] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [logoutRetention, setLogoutRetention] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [loading, setLoading] = useState(true);
  const pending = loadedScope.current === scopeKey ? pendingState : [];
  const pendingCount = useRef(0);
  pendingCount.current = pending.length;
  const workspace = workspaces.find((w) => w.id === workspaceId),
    canEdit = workspace?.role !== "viewer";
  useEffect(() => {
    setCapturing(false);
  }, [user?.id, workspaceId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        user &&
        workspace &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "q" &&
        !event.repeat &&
        !event.isComposing &&
        !target?.closest("input,textarea,select,[contenteditable=true]") &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        setCapturing(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [user?.id, workspace?.id, canEdit]);
  const active = resources.filter((r) => !r.deleted_at && !r.data.archived),
    projects = active.filter((r) => r.kind === "project"),
    tasks = active.filter((r) => r.kind === "task"),
    documents = active.filter((r) => r.kind === "document"),
    sprints = active.filter((r) => r.kind === "sprint");
  const selectedProject = projects.find((p) => p.id === projectId);
  const contextRef = useRef({ key: "", userId: "" });
  contextRef.current = {
    key: `${user?.id || ""}:${workspaceId}`,
    userId: user?.id || "",
  };
  const dataEpoch = useRef(0);
  useLocalGuard(
    creating
      ? "Hay un formulario de creación abierto. Guárdalo o ciérralo antes de cerrar sesión."
      : "",
  );
  useEffect(() => {
    if (!user) return;
    return coordinateLocalSession(user.id, () => {
      dataEpoch.current++;
      contextRef.current = { key: "", userId: "" };
      loadedScope.current = "";
      setNavigating(false);
      setResources([]);
      setMembers([]);
      setPending([]);
      setSelected(null);
      setCreating(null);
      setUser(null);
      setError("");
    });
  }, [user?.id]);
  const preparedWorkspace = useRef("");
  const navigationGuard = useRef<() => boolean>(() => true);
  const [routeRequest, setRouteRequest] = useState(() => ({
    route: readAppRoute(location.href, location.origin, history.state),
    sequence: 0,
    handled: false,
  }));
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const acceptedLocation = useRef({
    href: location.href,
    state: history.state,
  });
  const activeRefreshes = useRef(
    new Map<string, { promise: Promise<void>; rerun: boolean }>(),
  );
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  const signOut = async (preserveLocal = false) => {
    setLogoutRetention(false);
    try {
      await signOutEverywhereLocal(preserveLocal);
    } catch (issue) {
      setError((issue as Error).message);
      setLogoutRetention(issue instanceof LocalWorkRetained);
    }
  };
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 4500);
  };
  const refreshLocal = useCallback(async () => {
    if (!user || !workspaceId) return;
    const key = `${user.id}:${workspaceId}`,
      epoch = dataEpoch.current;
    const [snapshot, queued] = await Promise.all([
      localSnapshot(user.id, workspaceId),
      pendingOperations(user.id, workspaceId),
    ]);
    if (contextRef.current.key !== key || epoch !== dataEpoch.current) return;
    const map = new Map<string, Resource>(
      (snapshot?.resources || []).map((r) => [r.id, r]),
    );
    for (const operation of queued)
      map.set(operation.resource.id, operation.resource);
    loadedScope.current = key;
    setPending(queued);
    setResources([...map.values()]);
    setMembers(snapshot?.members || []);
    if (snapshot?.workspace)
      setWorkspaces((previous) =>
        previous.map((w) =>
          w.id === snapshot.workspace!.id ? snapshot.workspace! : w,
        ),
      );
  }, [user?.id, workspaceId]);
  const refresh = useCallback(async (): Promise<void> => {
    if (!user || !workspaceId) return;
    const key = `${user.id}:${workspaceId}`,
      running = activeRefreshes.current.get(key);
    if (running) {
      running.rerun = true;
      return running.promise;
    }
    const entry = { promise: Promise.resolve(), rerun: false };
    const work = async () => {
      if (contextRef.current.key === key) setSyncing(true);
      try {
        do {
          entry.rerun = false;
          const epoch = dataEpoch.current;
          let readSequence: number | undefined;
          try {
            await flushOutbox(user.id, workspaceId, () => {});
            readSequence = await beginSnapshotRead(user.id, workspaceId);
            const snapshot = await api(`/workspaces/${workspaceId}/resources`);
            if (contextRef.current.userId !== user.id) return;
            if (epoch !== dataEpoch.current) {
              entry.rerun = true;
              continue;
            }
            await cacheSnapshot(user.id, workspaceId, snapshot, readSequence);
            if (epoch !== dataEpoch.current) {
              entry.rerun = true;
              continue;
            }
            if (contextRef.current.key === key) {
              setOnline(true);
              setError("");
            }
          } catch (error) {
            if (contextRef.current.userId !== user.id) return;
            if (epoch !== dataEpoch.current) {
              entry.rerun = true;
              continue;
            }
            if (error instanceof ApiError && error.status === 403)
              await cacheSnapshot(
                user.id,
                workspaceId,
                {
                  resources: [],
                  members: [],
                },
                readSequence,
              );
            if (contextRef.current.key === key) {
              if (error instanceof ApiError && error.status === 401)
                setUser(null);
              else if (error instanceof ApiError) setError(error.message);
              else setOnline(false);
            }
          }
          await refreshLocal();
        } while (entry.rerun && contextRef.current.key === key);
      } finally {
        activeRefreshes.current.delete(key);
        if (contextRef.current.key === key) {
          setSyncing(false);
          setLoading(false);
        }
      }
    };
    activeRefreshes.current.set(key, entry);
    entry.promise = work();
    return entry.promise;
  }, [user?.id, workspaceId, refreshLocal]);
  useEffect(() => {
    if (
      !user ||
      !workspaceId ||
      !navigator.onLine ||
      !pending.some((item) => !item.error)
    )
      return;
    // An online event can precede cached session/outbox initialization.
    const timer = window.setTimeout(() => {
      void refresh().catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [user?.id, workspaceId, pending.length, online, refresh]);
  const loadSession = useCallback(async () => {
    const apply = (session: any) => {
      const route = readAppRoute(location.href, location.origin, history.state);
      if (
        contextRef.current.userId !== session.user.id &&
        route &&
        (route.type !== "page" || route.workspaceId)
      )
        setRouteRequest((previous) => ({
          ...previous,
          sequence: previous.sequence + 1,
          handled: false,
        }));
      setError("");
      authorizeLocalUser(session.user.id);
      setUser(session.user);
      setWorkspaces(session.workspaces);
      setPreferences(session.preferences);
      setProjectLayout(
        session.preferences?.projectLayout === "structure"
          ? "structure"
          : "cards",
      );
      setWorkspaceId((current) =>
        session.workspaces.some((w: Workspace) => w.id === current)
          ? current
          : session.workspaces[0]?.id || "",
      );
    };
    const generation = localStorage.getItem("kelvin-auth-generation");
    try {
      const session = await api("/me");
      if (generation !== localStorage.getItem("kelvin-auth-generation")) return;
      authorizeLocalUser(session.user.id);
      await rememberSession(session);
      if (generation !== localStorage.getItem("kelvin-auth-generation")) return;
      apply(session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await forgetSession();
      else if (!(e instanceof ApiError)) {
        const cached = await rememberedSession();
        if (cached) {
          apply(cached);
          setOnline(false);
        } else setError("No se pudo recuperar la sesión.");
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    api("/bootstrap")
      .then(setBoot)
      .catch(() => setBoot({ setupRequired: false }));
    void loadSession();
  }, [loadSession]);
  useEffect(() => {
    const key = `${user?.id || ""}:${workspaceId}`;
    if (preparedWorkspace.current === key) {
      preparedWorkspace.current = "";
      return;
    }
    loadedScope.current = "";
    setResources([]);
    setMembers([]);
    setSelected(null);
    setDeliveryFocus(null);
    setDashboardFocus(null);
    setTimeFocus(null);
    resetReminders();
    setProjectId(null);
    setHierarchyFocusId(null);
    setConfiguringFields(null);
    setConfiguringWorkflow(null);
    setLoading(true);
    const route = routeRequest.route;
    if (
      !routeRequest.handled &&
      route &&
      (route.type === "resource" ||
        (route.type === "page" &&
          (route.workspaceId || route.page !== "overview")))
    )
      return;
    void refreshLocal().then(refresh);
  }, [workspaceId, refresh, refreshLocal]);
  useEffect(() => {
    const wake = () => {
      setOnline(navigator.onLine);
      if (document.visibilityState === "visible") void refresh();
    };
    // Retry queued changes every 10 s, and pick up server-side work (delivered reminders,
    // other people's assignments) every 30 s while the tab is visible.
    let ticks = 0;
    const retry = setInterval(() => {
      ticks++;
      if (!navigator.onLine) return;
      if (pendingCount.current) void refresh();
      else if (ticks % 3 === 0 && document.visibilityState === "visible") void refresh();
    }, 10000);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(retry);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);
  useEffect(() => {
    if (!user || !workspaceId) return;
    const events = new EventSource(`/api/workspaces/${workspaceId}/events`);
    events.onmessage = () => void refresh();
    // After a reconnect, catch up on anything announced while the stream was down.
    let connectedOnce = false;
    events.onopen = () => {
      if (connectedOnce) void refresh();
      connectedOnce = true;
    };
    return () => events.close();
  }, [user?.id, workspaceId, refresh]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "k") {
        event.preventDefault();
        setCommand((v) => !v);
      }
      if (event.key === "Escape") {
        setMenu(false);
        setCommand(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    const theme = preferences.theme || "system";
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);
  const save = async (resource: Resource) => {
    if (!user || !workspaceId) return;
    if (resource.kind === "task" && !resource.deleted_at) {
      const definitions =
        resources.find(
          (r) => r.id === resource.data.projectId && r.kind === "project",
        )?.data.fieldDefinitions || [];
      const values = applyFieldDefaults(
        resource.data.customFields || {},
        definitions,
        resource.version ? "required" : "create",
      );
      for (const field of definitions) {
        if (field.archived) continue;
        const issue = fieldValueError(
          field,
          values[field.id],
          new Set(members.map((m) => m.id)),
          !!resource.version &&
            JSON.stringify(values[field.id]) ===
              JSON.stringify(
                resources.find((r) => r.id === resource.id)?.data
                  .customFields?.[field.id],
              ),
        );
        if (issue) throw new Error(`${field.name}: ${issue}`);
      }
      resource = {
        ...resource,
        data: normalizeTaskState(
          { ...resource.data, customFields: values },
          resources.find((r) => r.id === resource.id)?.data,
          resources.find(
            (r) => r.id === resource.data.projectId && r.kind === "project",
          ),
        ),
      };
    }
    const expected = resource.version || 0;
    const updated = {
      ...resource,
      workspace_id: workspaceId,
      created_by: resource.created_by || user.id,
      created_at: resource.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: expected + 1,
    };
    await queueMutation(user.id, workspaceId, updated, expected);
    await refreshLocal();
    if (navigator.onLine) void refresh();
    return updated;
  };
  const create = async (
    kind: ResourceKind,
    title: string,
    data: Record<string, any>,
  ) => {
    if (kind === "task") {
      const definitions =
        resources.find((r) => r.id === data.projectId && r.kind === "project")
          ?.data.fieldDefinitions || [];
      const values = { ...fieldDefaults(definitions), ...data.customFields };
      for (const field of definitions) {
        if (field.archived) continue;
        const issue = fieldValueError(
          field,
          values[field.id],
          new Set(members.map((m) => m.id)),
        );
        if (issue) throw new Error(`${field.name}: ${issue}`);
      }
      data = { ...data, customFields: values };
    }
    return save({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      kind,
      title,
      data,
      version: 0,
      created_by: user!.id,
      created_at: "",
      updated_at: "",
      deleted_at: null,
    });
  };
  const writePageLocation = (
    next: Page,
    workspace: string,
    project?: string,
    replace = false,
    containerId?: string,
  ) => {
    const href = pageHref(next, workspace || undefined, project, containerId);
    if (location.pathname + location.search !== href)
      history[replace ? "replaceState" : "pushState"]({ kelvin: {} }, "", href);
    window.dispatchEvent(
      new CustomEvent(navigationEvent, { detail: { handled: true } }),
    );
  };
  const navigate = (next: Page, id: string | null = null) => {
    if (!navigationGuard.current()) return;
    setSelected(null);
    writePageLocation(next, workspaceId, id || undefined);
    setDeliveryFocus(null);
    setDashboardFocus(null);
    setTimeFocus(null);
    resetReminders();
    setPage(next);
    setProjectId(id);
    if (next === "projects") setHierarchyFocusId(id);
    setQuery("");
    setMenu(false);
  };
  const switchWorkspace = (id: string) => {
    if (!navigationGuard.current()) return;
    setWorkspaceId(id);
    setSelected(null);
    setDeliveryFocus(null);
    setDashboardFocus(null);
    setTimeFocus(null);
    resetReminders();
    setPage("overview");
    setProjectId(null);
    writePageLocation("overview", id);
  };
  const updatePreference = async (patch: any) => {
    setPreferences((p: any) => ({ ...p, ...patch }));
    try {
      await api("/preferences", send(patch, "PUT"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggleFavorite = (id: string) =>
    void updatePreference({
      favorites: (preferences.favorites || []).includes(id)
        ? preferences.favorites.filter((v: string) => v !== id)
        : [...(preferences.favorites || []), id],
    });
  const openResource = (resource: Resource) => {
    if (!navigationGuard.current()) return;
    localResourceLocation(
      resource.id,
      page,
      projectId || undefined,
      page === "projects" && projectLayout === "structure"
        ? hierarchyFocusId || undefined
        : undefined,
      page === "reports" ? dashboardFocus || undefined : undefined,
    );
    if (resource.kind === "reminder") {
      setReminderFocus(resource.id);
      setReminderTarget(null);
      setReminderCreationRequested(false);
      setPage("reminders");
      setSelected(null);
      setProjectId(null);
    } else if (resource.kind === "time_entry") {
      setTimeFocus(resource.id);
      setPage("time");
      setSelected(null);
      setProjectId(null);
    } else if (resource.kind === "dashboard") {
      setDashboardFocus(resource.id);
      setPage("reports");
      setSelected(null);
      setProjectId(null);
    } else if (isDelivery(resource)) {
      setDeliveryFocus(resource.id);
      setPage("planning");
      setProjectId(null);
      setSelected(null);
    } else setSelected(resource);
    void updatePreference({
      recent: [
        resource.id,
        ...(preferences.recent || []).filter(
          (id: string) => id !== resource.id,
        ),
      ].slice(0, 20),
    });
  };
  useEffect(() => {
    const onLocation = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail?.handled && !navigationGuard.current()) {
        if (event.type === "popstate")
          history.pushState(
            acceptedLocation.current.state,
            "",
            acceptedLocation.current.href,
          );
        return;
      }
      if (detail?.handled) {
        setNavigating(false);
        setNavigationError("");
      }
      if (event.type === "popstate") {
        const previous = new URL(acceptedLocation.current.href),
          current = new URL(location.href);
        if (
          previous.pathname === current.pathname &&
          previous.search === current.search &&
          previous.hash !== current.hash
        ) {
          acceptedLocation.current = {
            href: location.href,
            state: history.state,
          };
          return;
        }
      }
      if (detail?.href) {
        const route = readAppRoute(detail.href, location.origin);
        if (route?.type !== "resource") return;
        history.pushState({}, "", detail.href);
      }
      acceptedLocation.current = { href: location.href, state: history.state };
      setRouteRequest((previous) => ({
        route: readAppRoute(location.href, location.origin, history.state),
        sequence: previous.sequence + 1,
        handled: !!detail?.handled,
      }));
    };
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href);
      if (
        destination.hash &&
        destination.pathname === location.pathname &&
        destination.search === location.search
      )
        return;
      const route = readAppRoute(anchor.href, location.origin);
      if (route?.type !== "resource") return;
      const editing = !!anchor.closest('[contenteditable="true"]');
      if (anchor.target === "_blank" && !editing) return;
      if (event.ctrlKey || event.metaKey) {
        if (editing) {
          event.preventDefault();
          event.stopPropagation();
          window.open(anchor.href, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (editing) return;
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent(navigationEvent, { detail: { href: anchor.href } }),
      );
    };
    window.addEventListener(navigationEvent, onLocation);
    window.addEventListener("popstate", onLocation);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener(navigationEvent, onLocation);
      window.removeEventListener("popstate", onLocation);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    if (routeRequest.handled) {
      if (loadedScope.current !== contextRef.current.key)
        void refreshLocal().then(refresh);
      return;
    }
    if (!routeRequest.route) return;
    const route = routeRequest.route;
    if (route.type === "invalid") {
      setNavigationError("El enlace no es válido.");
      setNavigating(false);
      return;
    }
    // Root startup keeps the ordinary workspace bootstrap; explicit routes resolve independently.
    if (
      route.type === "page" &&
      route.page === "overview" &&
      !route.workspaceId &&
      routeRequest.sequence === 0
    )
      return;
    const controller = new AbortController();
    let disposed = false;
    const stillCurrent = () =>
      !disposed && contextRef.current.userId === user.id;
    dataEpoch.current++;
    setSelected(null);
    setDeliveryFocus(null);
    setDashboardFocus(null);
    setTimeFocus(null);
    resetReminders();
    setNavigating(true);
    void resolveNavigation(
      user.id,
      workspaces,
      workspaceId,
      route,
      controller.signal,
      stillCurrent,
    )
      .then(async (result) => {
        if (!stillCurrent()) return;
        dataEpoch.current++;
        const nextKey = `${user.id}:${result.workspace.id}`;
        if (contextRef.current.key !== nextKey)
          preparedWorkspace.current = nextKey;
        contextRef.current = { key: nextKey, userId: user.id };
        loadedScope.current = nextKey;
        const updatedWorkspaces = [
          ...workspaces.filter((w) => w.id !== result.workspace.id),
          result.workspace,
        ].sort(
          (a, b) =>
            workspaces.findIndex((w) => w.id === a.id) -
            workspaces.findIndex((w) => w.id === b.id),
        );
        setWorkspaces(updatedWorkspaces);
        setWorkspaceId(result.workspace.id);
        setResources(result.snapshot.resources);
        setMembers(result.snapshot.members);
        setPending(await pendingOperations(user.id, result.workspace.id));
        if (!stillCurrent()) return;
        setSelected(null);
        setDeliveryFocus(null);
        setDashboardFocus(null);
        setTimeFocus(null);
        resetReminders();
        setCreating(null);
        setConfiguringFields(null);
        setConfiguringWorkflow(null);
    setConfiguringWorkflow(null);
        setMenu(false);
        // The palette stays open: it closes itself when an entry is chosen.
        setProjectId(null);
        setHierarchyFocusId(null);
        setQuery("");
        setNavigationError("");
        setOnline(!result.offline);
        setLoading(false);
        setSyncing(false);
        if (route.type === "resource" && result.resource) {
          const target = result.resource;
          if (
            route.backdrop?.dashboardId &&
            result.snapshot.resources.some(
              (r) =>
                r.id === route.backdrop!.dashboardId &&
                r.kind === "dashboard" &&
                !r.deleted_at,
            )
          )
            setDashboardFocus(route.backdrop.dashboardId);
          const inferred: Page =
            target.kind === "reminder"
              ? "reminders"
              : target.data.personalNote
                ? "notes"
                : target.kind === "task"
                  ? "tasks"
                  : target.kind === "document"
                    ? "documents"
                    : target.kind === "project" || target.kind === "folder"
                      ? "projects"
                      : target.kind === "sprint"
                        ? "sprints"
                        : target.kind === "time_entry"
                          ? "time"
                          : target.kind === "dashboard"
                            ? "reports"
                            : target.kind === "template"
                              ? "templates"
                              : "planning";
          setPage(
            isDelivery(target) ? "planning" : route.backdrop?.page || inferred,
          );
          if (
            route.backdrop?.page === "projects" &&
            route.backdrop.containerId &&
            result.snapshot.resources.some(
              (r) =>
                r.id === route.backdrop!.containerId &&
                isStructure(r) &&
                !r.deleted_at,
            )
          ) {
            setProjectLayout("structure");
            setHierarchyFocusId(route.backdrop.containerId);
          }
          if (
            route.backdrop?.projectId &&
            result.snapshot.resources.some(
              (r) =>
                r.id === route.backdrop!.projectId &&
                r.kind === "project" &&
                !r.deleted_at,
            )
          )
            setProjectId(route.backdrop.projectId);
          if (target.kind === "folder") {
            setPage("projects");
            setProjectLayout("structure");
            setHierarchyFocusId(target.id);
          } else if (target.kind === "reminder") {
            setPage("reminders");
            setReminderFocus(target.id);
          } else if (target.kind === "time_entry") {
            setPage("time");
            setTimeFocus(target.id);
          } else if (target.kind === "dashboard") {
            setPage("reports");
            setDashboardFocus(target.id);
          } else if (isDelivery(target)) setDeliveryFocus(target.id);
          else setSelected(target);
        } else if (route.type === "page") {
          setPage(route.page);
          if (
            route.page === "projects" &&
            route.containerId &&
            result.snapshot.resources.some(
              (r) =>
                r.id === route.containerId && isStructure(r) && !r.deleted_at,
            )
          ) {
            setProjectLayout("structure");
            setHierarchyFocusId(route.containerId);
          }
          if (route.page === "projects" && route.projectId) {
            setProjectLayout("structure");
            setHierarchyFocusId(route.projectId);
          }
          if (
            route.projectId &&
            result.snapshot.resources.some(
              (r) =>
                r.id === route.projectId &&
                r.kind === "project" &&
                !r.deleted_at,
            )
          )
            setProjectId(route.projectId);
        }
        await rememberSession({
          user,
          workspaces: updatedWorkspaces,
          preferences,
        });
      })
      .catch((error) => {
        if (!stillCurrent() || controller.signal.aborted) return;
        setSelected(null);
        setDeliveryFocus(null);
        setDashboardFocus(null);
        setTimeFocus(null);
        resetReminders();
        if (error instanceof ApiError && error.status === 401) setUser(null);
        setNavigationError(
          error instanceof Error
            ? error.message
            : "No se pudo abrir el enlace.",
        );
        void refresh();
      })
      .finally(() => {
        if (stillCurrent()) setNavigating(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [user?.id, routeRequest.sequence]);
  const heading =
    selectedProject?.title ||
    pageTitles[page] ||
    (page === "trash" ? "Papelera" : "Configuración");
  const defaultKind: ResourceKind =
    page === "projects"
      ? "project"
      : page === "documents"
        ? "document"
        : page === "sprints"
          ? "sprint"
          : "task";

  if (!user)
    return (
      <Auth
        boot={boot}
        error={error}
        ready={() => {
          setError("");
          void loadSession();
        }}
      />
    );
  return (
    <DragProvider onError={(message) => setError(message)}>
    <div className={`app-shell ${selected ? "with-panel" : ""}`}>
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      {menu && (
        <button
          className="nav-scrim"
          aria-label="Cerrar navegación"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <img src="/mark.svg" alt="" />
          <span>
            Dayline<span className="brand-sub">Tu día de trabajo</span>
          </span>
        </a>
        <label className="workspace-picker">
          <span className="sr-only">Espacio de trabajo</span>
          <select
            aria-label="Espacio de trabajo"
            value={workspaceId}
            onChange={(e) => switchWorkspace(e.target.value)}
          >
            {workspaces
              .filter(
                (w) =>
                  w.id === workspaceId ||
                  !(preferences.hiddenWorkspaces || []).includes(w.id),
              )
              .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <button className="nav-search" onClick={() => setCommand(true)}>
          <Search size={16} />
          <span>Buscar o ir a…</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Principal">
          {(["mine", "team"] as const).map((section) => (
            <div key={section} className={`nav-section nav-section-${section}`}>
              <p className="nav-group">{section === "mine" ? "Mi trabajo" : "Equipo"}</p>
              {navGroups
                .filter((group) => group.section === section)
                .map(({ label, icon: Icon, pages }) => {
                  const count =
                    label === "Mis tareas"
                      ? tasks.filter(
                          (t) =>
                            t.data.assigneeId === user.id &&
                            !["done", "cancelled"].includes(t.data.status),
                        ).length
                      : label === "Bandeja"
                        ? active.filter(
                            (r) =>
                              r.kind === "notification" &&
                              r.data.assigneeId === user.id &&
                              !r.data.read &&
                              !(r.data.snoozedUntil && Date.parse(r.data.snoozedUntil) > Date.now()),
                          ).length
                        : 0;
                  const current = pages.includes(page) && !projectId;
                  return (
                    <button
                      key={label}
                      className={`nav-item ${current ? "selected" : ""}`}
                      aria-current={current ? "page" : undefined}
                      onClick={() => navigate(pages[0])}
                    >
                      <span className={`nav-icon tone-${pages[0]}`}>
                        <Icon size={16} />
                      </span>
                      <span>{label}</span>
                      {count > 0 && <span className="nav-count">{count}</span>}
                    </button>
                  );
                })}
              {section === "mine" && (
                <div className="project-nav">
                  <p className="nav-group">
                    Proyectos
                    {canEdit && (
                      <button
                        aria-label="Crear proyecto"
                        onClick={() => setCreating("project")}
                      >
                        <Plus size={14} />
                      </button>
                    )}
                  </p>
                  {(() => {
                    const ids: string[] = preferences.favorites || [];
                    const favorites = ids
                      .map((id) => projects.find((p) => p.id === id))
                      .filter(Boolean) as Resource[];
                    const list = (favorites.length ? favorites : projects).slice(0, 6);
                    return list.map((p) => (
                      <SidebarProject
                        key={p.id}
                        project={p}
                        selected={projectId === p.id}
                        favorite={favorites.length > 0}
                        canEdit={canEdit}
                        open={() => navigate("tasks", p.id)}
                        moveTask={async (task) => {
                          if (task.data.projectId === p.id) return;
                          await save({ ...task, data: { ...task.data, projectId: p.id } });
                          notify(`«${task.title}» movida a ${p.title}.`);
                        }}
                        reorder={(id) => {
                          const next = ids.filter((v) => v !== id);
                          next.splice(next.indexOf(p.id), 0, id);
                          void updatePreference({ favorites: next });
                        }}
                      />
                    ));
                  })()}
                  <button
                    className={`nav-item nav-all-projects ${page === "projects" && !projectId ? "selected" : ""}`}
                    aria-current={page === "projects" && !projectId ? "page" : undefined}
                    onClick={() => navigate("projects")}
                  >
                    <span className="nav-icon tone-projects">
                      <FolderKanban size={16} />
                    </span>
                    <span>Todos los proyectos</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${settingsPages.includes(page) ? "selected" : ""}`}
            aria-current={settingsPages.includes(page) ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <Settings size={17} />
            Configuración
          </button>
          <div className="user-row">
            <span className="avatar">
              {user.name.slice(0, 2).toUpperCase()}
            </span>
            <span>
              <strong>{user.name}</strong>
              <small>
                {workspace?.role === "admin"
                  ? "Administrador"
                  : workspace?.role === "viewer"
                    ? "Solo lectura"
                    : "Miembro"}
              </small>
            </span>
            <button
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              onClick={async () => {
                await signOut();
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Abrir navegación"
            onClick={() => setMenu(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>{workspace?.name}</span>
            <ChevronRight size={13} />
            <span>{heading}</span>
          </div>
          <div className="connection" role="status">
            {syncing ? (
              <LoaderCircle size={14} className="spin" />
            ) : !online ? (
              <WifiOff size={14} />
            ) : (
              <span className="online-dot" />
            )}
            <span>
              {syncing
                ? "Sincronizando"
                : !online
                  ? pending.length
                    ? `Sin conexión · ${pending.length} ${pending.length === 1 ? "cambio pendiente" : "cambios pendientes"}`
                    : "Sin conexión"
                  : pending.length
                    ? `${pending.length} cambios pendientes`
                    : "Sincronizado"}
            </span>
          </div>
          {workspace && (
            <button
              className="icon-button quick-capture-trigger"
              aria-label={
                canEdit ? "Captura rápida" : "Recuperar captura local"
              }
              aria-keyshortcuts="Alt+Q"
              title={
                canEdit
                  ? "Captura rápida (Alt+Q)"
                  : "Recuperar captura local (Alt+Q)"
              }
              onClick={() => setCapturing(true)}
            >
              <Plus size={19} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Abrir asistente IA"
            onClick={() => navigate("ai")}
          >
            <Sparkles size={18} />
          </button>
        </header>
        <main
          id="main"
          className={`sheet ${settingsPages.includes(page) ? "settings-layout" : ""}`}
        >
          {selectedProject && (
            <nav aria-label="Vistas del proyecto" className="section-tabs">
              {projectTabs.map(([key, label]) => (
                <button
                  key={key}
                  className={key === page ? "active" : ""}
                  aria-current={key === page ? "page" : undefined}
                  onClick={() => navigate(key, selectedProject.id)}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
          {settingsPages.includes(page) && (
            <nav aria-label="Secciones" className="settings-nav">
              {settingsGroups.map(([label, keys]) => (
                <div key={label} className="settings-nav-group">
                  <p>{label}</p>
                  {keys
                    .filter((key) => key !== "platform" || (user as any).platformAdmin)
                    .map((key) => (
                      <button
                        key={key}
                        className={key === page ? "active" : ""}
                        aria-current={key === page ? "page" : undefined}
                        onClick={() => navigate(key)}
                      >
                        {pageTitles[key]}
                      </button>
                    ))}
                </div>
              ))}
            </nav>
          )}
          {!selectedProject && !settingsPages.includes(page) && pageGroup(page).length > 1 && (
            <nav aria-label="Secciones" className="section-tabs">
              {pageGroup(page)
                .filter((key) => key !== "platform" || (user as any).platformAdmin)
                .map((key) => (
                <button
                  key={key}
                  className={key === page ? "active" : ""}
                  aria-current={key === page ? "page" : undefined}
                  onClick={() => navigate(key)}
                >
                  {pageTitles[key]}
                </button>
              ))}
            </nav>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {selectedProject
                  ? "Proyecto"
                  : new Intl.DateTimeFormat("es", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    }).format(new Date())}
              </div>
              <h1>{heading}</h1>
              {selectedProject?.data.description && (
                <p>{selectedProject.data.description}</p>
              )}
            </div>
            <div className="heading-actions">
              {selectedProject && (
                <button
                  className="icon-button"
                  aria-label="Editar proyecto"
                  onClick={() => openResource(selectedProject)}
                >
                  <MoreHorizontal size={18} />
                </button>
              )}
              {canEdit &&
                [
                  "overview",
                  "projects",
                  "tasks",
                  "documents",
                  "sprints",
                  "my_tasks",
                ].includes(page) &&
                (page !== "projects" || projectLayout === "cards") && (
                  <button
                    className="primary"
                    onClick={() => setCreating(defaultKind)}
                  >
                    <Plus size={16} />
                    {page === "projects"
                      ? "Nuevo proyecto"
                      : page === "documents"
                        ? "Nuevo documento"
                        : page === "sprints"
                          ? "Nuevo sprint"
                          : "Nueva tarea"}
                  </button>
                )}
            </div>
          </div>
          {navigating && <p role="status">Abriendo enlace…</p>}
          {navigationError && (
            <div className="notice error navigation-error" role="alert">
              <span>{navigationError}</span>
              <button
                className="secondary"
                onClick={() =>
                  setRouteRequest((previous) => ({
                    ...previous,
                    sequence: previous.sequence + 1,
                    handled: false,
                  }))
                }
              >
                Reintentar enlace
              </button>
              <button
                className="icon-button"
                aria-label="Cerrar aviso del enlace"
                onClick={() => setNavigationError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              <span>{error}</span>
              {logoutRetention && (
                <div>
                  <p>
                    Las copias seguirán en este dispositivo. Necesitarás iniciar
                    sesión con la misma cuenta para recuperarlas.
                  </p>
                  <button type="button" onClick={() => void signOut(true)}>
                    Conservar copias locales y cerrar sesión
                  </button>
                </div>
              )}
              <button aria-label="Cerrar aviso" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {pending
            .filter((p) => p.error)
            .map((item) => (
              <div className="notice warning" key={item.key}>
                <div>
                  <strong>Revisa el cambio en «{item.resource.title}»</strong>
                  <p>{item.error}</p>
                </div>
                {item.current && (
                  <button
                    onClick={async () => {
                      await resolveConflict(user.id, item.key, true);
                      void refresh();
                    }}
                  >
                    Conservar mi versión
                  </button>
                )}
                <button
                  onClick={async () => {
                    await resolveConflict(user.id, item.key, false);
                    void refreshLocal();
                  }}
                >
                  Usar la del servidor
                </button>
                <button
                  onClick={() =>
                    download(
                      `${item.resource.title}-borrador.json`,
                      JSON.stringify(item.resource, null, 2),
                      "application/json",
                    )
                  }
                >
                  Exportar borrador
                </button>
              </div>
            ))}
          {loading && !resources.length ? (
            <div className="loading" role="status">
              <LoaderCircle className="spin" size={22} />
              Abriendo tu espacio…
            </div>
          ) : (
            <>
              {page === "overview" && (
                <Today
                  resources={resources}
                  projects={projects}
                  user={user}
                  open={openResource}
                  navigate={navigate}
                  complete={(task) =>
                    save({ ...task, data: { ...task.data, status: "done" } })
                  }
                  capture={() => setCapturing(true)}
                  canEdit={canEdit}
                />
              )}
              {["tasks", "my_tasks"].includes(page) && (
                <Suspense
                  fallback={<p role="status">Preparando las tareas…</p>}
                >
                  <TaskCollection
                    key={`${workspaceId}:${page}:${projectId}`}
                    resources={resources}
                    members={members}
                    user={user}
                    workspace={workspace!}
                    projectId={projectId}
                    myTasks={page === "my_tasks"}
                    canEdit={canEdit}
                    create={create}
                    save={save}
                    refresh={refresh}
                    open={openResource}
                  />
                </Suspense>
              )}
              {page === "projects" && (
                <>
                  <div
                    className="structure-view-switch"
                    role="group"
                    aria-label="Vista de proyectos"
                  >
                    <button
                      aria-pressed={projectLayout === "cards"}
                      onClick={() => {
                        setProjectLayout("cards");
                        void updatePreference({ projectLayout: "cards" });
                      }}
                    >
                      Tarjetas
                    </button>
                    <button
                      aria-pressed={projectLayout === "structure"}
                      onClick={() => {
                        setProjectLayout("structure");
                        void updatePreference({ projectLayout: "structure" });
                      }}
                    >
                      Estructura
                    </button>
                  </div>
                  {projectLayout === "structure" && user && workspace ? (
                    <Suspense
                      fallback={<p role="status">Abriendo la estructura…</p>}
                    >
                      <ProjectStructure
                        key={scopeKey}
                        resources={resources}
                        workspace={workspace}
                        user={user}
                        canEdit={canEdit}
                        focusId={hierarchyFocusId}
                        setFocus={(id) => {
                          setHierarchyFocusId(id);
                          setProjectId(null);
                          writePageLocation(
                            "projects",
                            workspaceId,
                            undefined,
                            false,
                            id || undefined,
                          );
                        }}
                        open={openResource}
                        openTasks={(id) => navigate("tasks", id)}
                        configureFields={setConfiguringFields}
                        configureWorkflow={setConfiguringWorkflow}
                        create={create}
                        save={save}
                        refresh={refresh}
                      />
                    </Suspense>
                  ) : (
                    <>
                      <SearchField value={query} set={setQuery} />
                      <div className="projects-grid">
                        {projects
                          .filter((p) =>
                            p.title.toLowerCase().includes(query.toLowerCase()),
                          )
                          .map((project) => {
                            const ownTasks = tasks.filter(
                              (t) => t.data.projectId === project.id,
                            );
                            const stats = sprintStats(ownTasks);
                            return (
                              <article
                                className="project-card"
                                key={project.id}
                              >
                                <div className="project-card-header">
                                  <FolderKanban size={20} />
                                  <button
                                    className="icon-button"
                                    aria-label={
                                      (preferences.favorites || []).includes(
                                        project.id,
                                      )
                                        ? "Quitar de favoritos"
                                        : "Añadir a favoritos"
                                    }
                                    onClick={() => toggleFavorite(project.id)}
                                  >
                                    <Star
                                      size={16}
                                      fill={
                                        (preferences.favorites || []).includes(
                                          project.id,
                                        )
                                          ? "currentColor"
                                          : "none"
                                      }
                                    />
                                  </button>
                                </div>
                                <button
                                  className="card-title"
                                  onClick={() => navigate("tasks", project.id)}
                                >
                                  {project.title}
                                  <ArrowRight size={16} />
                                </button>
                                <p>
                                  {project.data.description ||
                                    "Añade el objetivo y reúne el trabajo del proyecto."}
                                </p>
                                <div className="progress-track">
                                  <span
                                    style={{ width: `${stats.percent}%` }}
                                  />
                                </div>
                                <div className="project-footer">
                                  <span>
                                    {stats.done} de {stats.total} tareas
                                  </span>
                                  <span>{stats.percent}%</span>
                                </div>
                                <button
                                  className="text-button"
                                  onClick={() => openResource(project)}
                                >
                                  Detalles del proyecto
                                </button>
                                {canEdit &&
                                  (workspace?.role === "admin" ||
                                    project.created_by === user?.id) && (
                                    <button
                                      className="text-button"
                                      onClick={() =>
                                        setConfiguringFields(project)
                                      }
                                    >
                                      Campos de tareas
                                    </button>
                                  )}
                                {canEdit &&
                                  (workspace?.role === "admin" ||
                                    project.created_by === user?.id) && (
                                    <button
                                      className="text-button"
                                      onClick={() =>
                                        setConfiguringWorkflow(project)
                                      }
                                    >
                                      Flujo de estados
                                    </button>
                                  )}
                              </article>
                            );
                          })}
                      </div>
                      {!projects.length && (
                        <Empty
                          icon={FolderKanban}
                          title="Un lugar para cada proyecto"
                          description="Reúne las tareas, los documentos y las decisiones de tu próximo proyecto."
                          action={canEdit ? "Crear proyecto" : undefined}
                          onAction={() => setCreating("project")}
                        />
                      )}
                    </>
                  )}
                </>
              )}
              {page === "documents" && (
                <>
                  <SearchField value={query} set={setQuery} />
                  <div className="document-list">
                    {documents
                      .filter((d) => !projectId || d.data.projectId === projectId)
                      .filter((d) =>
                        `${d.title} ${d.data.description || ""}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((d) => (
                        <button
                          className="document-row"
                          key={d.id}
                          onClick={() => openResource(d)}
                        >
                          <FileText size={22} />
                          <div>
                            <strong>{d.title}</strong>
                            <p>
                              {projects.find((p) => p.id === d.data.projectId)
                                ?.title ||
                                (d.data.personalNote
                                  ? "Nota personal · Solo tu cuenta"
                                  : "Documento del espacio")}{" "}
                              · Actualizado {dateText(d.updated_at)}
                            </p>
                          </div>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                  </div>
                  {!documents.length && (
                    <Empty
                      icon={FileText}
                      title="Las buenas ideas necesitan contexto"
                      description="Especificaciones, notas de reuniones y decisiones: empieza con una página."
                      action={canEdit ? "Crear documento" : undefined}
                      onAction={() => setCreating("document")}
                    />
                  )}
                </>
              )}
              {page === "sprints" && (
                <Suspense
                  fallback={<p role="status">Abriendo la planificación…</p>}
                >
                  <SprintWorkspace
                    workspaceId={workspaceId}
                    resources={active}
                    members={members}
                    user={user}
                    open={openResource}
                    create={create}
                    newSprint={() => setCreating("sprint")}
                    save={save}
                    refresh={refresh}
                  />
                </Suspense>
              )}
              {page === "calendar" && (
                <Calendar
                  tasks={projectId ? tasks.filter((t) => t.data.projectId === projectId) : tasks}
                  open={openResource}
                  save={save}
                  canEdit={canEdit}
                  reminders={active.filter(
                    (r) => r.kind === "reminder" && r.data.reminder?.enabled && r.created_by === user.id,
                  )}
                  sprints={projectId ? [] : sprints}
                />
              )}
              {page === "team" && (
                <Team
                  members={members}
                  workspace={workspace!}
                  refresh={refresh}
                  error={setError}
                />
              )}
              {page === "notes" && (
                <Suspense fallback={<p role="status">Abriendo tus notas…</p>}>
                  <PrivateNotes
                    key={`${user.id}:${workspaceId}`}
                    resources={resources}
                    user={user}
                    workspace={workspace!}
                    canEdit={canEdit}
                    save={save}
                    open={openResource}
                  />
                </Suspense>
              )}
              {page === "reminders" && (
                <Suspense
                  fallback={<p role="status">Abriendo tus recordatorios…</p>}
                >
                  <Reminders
                    key={`${workspaceId}:${reminderFocus || "new"}:${reminderTarget || ""}`}
                    resources={resources}
                    user={user}
                    workspace={workspace!}
                    canEdit={canEdit}
                    timeZone={
                      preferences.timeZone ||
                      Intl.DateTimeFormat().resolvedOptions().timeZone
                    }
                    focusId={reminderFocus}
                    targetId={reminderTarget}
                    startNew={reminderCreationRequested}
                    open={openResource}
                    save={save}
                    close={(createNew = false) => {
                      resetReminders();
                      setReminderCreationRequested(createNew);
                      writePageLocation("reminders", workspaceId);
                    }}
                  />
                </Suspense>
              )}
              {page === "time" && (
                <Suspense
                  fallback={
                    <p role="status">Preparando el registro de tiempo…</p>
                  }
                >
                  <TimeTracking
                    key={`${workspaceId}:${timeFocus || "new"}`}
                    resources={resources}
                    members={members}
                    user={user}
                    workspace={workspace!}
                    canEdit={canEdit}
                    timeZone={
                      preferences.timeZone ||
                      Intl.DateTimeFormat().resolvedOptions().timeZone
                    }
                    focusId={timeFocus}
                    open={openResource}
                    startNew={timeCreationRequested}
                    close={(createNew = false) => {
                      setTimeFocus(null);
                      resetReminders();
                      setTimeCreationRequested(createNew);
                      writePageLocation("time", workspaceId);
                    }}
                    save={save}
                  />
                </Suspense>
              )}
              {["reports", "time"].includes(page) && (
                <WorkKpis resources={active} projectId={projectId} />
              )}
              {page === "reports" && (
                <Suspense
                  fallback={<p role="status">Preparando los informes…</p>}
                >
                  <Reports
                    key={`${workspaceId}:${dashboardFocus || "default"}`}
                    resources={resources}
                    members={members}
                    user={user}
                    workspace={workspace!}
                    canEdit={canEdit}
                    focusId={dashboardFocus}
                    choose={(panel) => {
                      if (panel) openResource(panel);
                      else {
                        setDashboardFocus(null);
                        setTimeFocus(null);
                        resetReminders();
                        writePageLocation("reports", workspaceId);
                      }
                    }}
                    open={openResource}
                    create={create}
                    save={save}
                  />
                </Suspense>
              )}
              {page === "platform" && (user as any).platformAdmin && (
                <Suspense fallback={<p role="status">Abriendo la administración…</p>}>
                  <PlatformAdmin user={user} notify={notify} />
                </Suspense>
              )}
              {page === "platform" && !(user as any).platformAdmin && (
                <p className="notice">
                  Esta sección es solo para la administración de la plataforma.
                </p>
              )}
              {page === "workspaces" && (
                <Suspense fallback={<p role="status">Abriendo tus espacios…</p>}>
                  <WorkspaceManager
                    workspaces={workspaces}
                    currentId={workspaceId}
                    user={user}
                    hidden={preferences.hiddenWorkspaces || []}
                    setHidden={(ids) =>
                      void updatePreference({ hiddenWorkspaces: ids })
                    }
                    open={switchWorkspace}
                    reload={loadSession}
                    notify={notify}
                    error={setError}
                  />
                </Suspense>
              )}
              {page === "settings" && (
                <SettingsView
                  user={user}
                  workspace={workspace!}
                  preferences={preferences}
                  updatePreference={updatePreference}
                  preferencesSaved={(patch: any) =>
                    setPreferences((previous: any) => ({
                      ...previous,
                      ...patch,
                    }))
                  }
                  notify={notify}
                  error={setError}
                  reload={loadSession}
                />
              )}
              {page === "ai" && (
                <AIView
                  workspaceId={workspaceId}
                  resources={active}
                  error={setError}
                  create={create}
                  open={openResource}
                />
              )}
              {page === "activity" && (
                <Activity
                  workspaceId={workspaceId}
                  resources={resources}
                  open={openResource}
                />
              )}
              {page === "trash" && (
                <div className="document-list">
                  {resources
                    .filter((r) => r.deleted_at)
                    .map((r) => (
                      <div className="document-row" key={r.id}>
                        <Trash2 size={18} />
                        <div>
                          <strong>{r.title}</strong>
                          <p>{kindLabels[r.kind]}</p>
                        </div>
                        {canEdit && (
                          <button
                            onClick={() =>
                              void save({
                                ...r,
                                ...(r.kind === "reminder"
                                  ? {
                                      data: {
                                        ...r.data,
                                        reminder: {
                                          ...r.data.reminder,
                                          enabled: false,
                                          revisionId: crypto.randomUUID(),
                                        },
                                      },
                                    }
                                  : {}),
                                deleted_at: null,
                              })
                            }
                          >
                            Restaurar
                          </button>
                        )}
                      </div>
                    ))}
                  {!resources.some((r) => r.deleted_at) && (
                    <Empty
                      icon={Trash2}
                      title="La papelera está vacía"
                      description="Los elementos eliminados se conservarán aquí para poder recuperarlos."
                    />
                  )}
                </div>
              )}
              {page === "inbox" && (
                <Suspense fallback={<p role="status">Abriendo la bandeja…</p>}>
                  <InboxTriage resources={active} user={user} save={save} open={openResource} />
                </Suspense>
              )}
              {page === "templates" && (
                <Suspense
                  fallback={<p role="status">Preparando las plantillas…</p>}
                >
                  <TemplateLibrary
                    key={workspaceId}
                    resources={resources}
                    user={user}
                    workspace={workspace!}
                    canEdit={canEdit}
                    create={create}
                    save={save}
                    refresh={refresh}
                  />
                </Suspense>
              )}
              {page === "planning" && (
                <Suspense
                  fallback={<p role="status">Preparando las entregas…</p>}
                >
                  <DeliveryWorkspace
                    key={projectId || "all"}
                    initialProjectId={projectId || ""}
                    resources={resources}
                    members={members}
                    user={user}
                    workspace={workspace!}
                    focusId={deliveryFocus}
                    setFocus={(id) => {
                      setDeliveryFocus(id);
                      if (id) localResourceLocation(id, "planning");
                      else
                        writePageLocation(
                          "planning",
                          workspaceId,
                          undefined,
                          true,
                        );
                    }}
                    open={openResource}
                    create={create}
                    save={save}
                    refresh={refresh}
                    legacyCreate={setCreating}
                    discuss={setSelected}
                  />
                </Suspense>
              )}
            </>
          )}
        </main>
      </div>
      {creating && (
        <CreateDialog
          kind={creating}
          projects={projects}
          sprints={sprints}
          members={members}
          projectId={projectId}
          close={() => setCreating(null)}
          submit={async (title: string, data: Record<string, any>) => {
            try {
              const result = await create(creating, title, data);
              setCreating(null);
              if (result) openResource(result);
              notify("Guardado en este dispositivo.");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
      {selected &&
        selected.workspace_id === workspaceId &&
        resources.some((r) => r.id === selected.id) && (
          <ResourceDialog
            key={selected.id}
            resource={resources.find((r) => r.id === selected.id)!}
            resources={active}
            members={members}
            canEdit={canEdit}
            workspaceId={workspaceId}
            user={user}
            workspaceRole={workspace?.role}
            navigationGuard={navigationGuard}
            requestReminder={(resource: Resource) => {
              if (!navigationGuard.current()) return;
              setSelected(null);
              resetReminders();
              setReminderTarget(resource.id);
              setReminderCreationRequested(true);
              setPage("reminders");
              setProjectId(null);
              writePageLocation("reminders", workspaceId);
            }}
            close={() => {
              setSelected(null);
              if (
                page === "reports" &&
                dashboardFocus &&
                resources.some(
                  (r) =>
                    r.id === dashboardFocus &&
                    r.kind === "dashboard" &&
                    !r.deleted_at,
                )
              )
                localResourceLocation(dashboardFocus, "reports");
              else if (!deliveryFocus)
                writePageLocation(
                  page,
                  workspaceId,
                  projectId || undefined,
                  true,
                  page === "projects" && projectLayout === "structure"
                    ? hierarchyFocusId || undefined
                    : undefined,
                );
            }}
            save={save}
            create={create}
            open={openResource}
            error={setError}
            notify={notify}
            showStructure={(resource: Resource) => {
              if (!navigationGuard.current()) return;
              const containerId =
                resource.kind === "document"
                  ? structureParent(resource)
                  : resource.id;
              setSelected(null);
              setPage("projects");
              setProjectLayout("structure");
              setHierarchyFocusId(containerId);
              setProjectId(null);
              writePageLocation(
                "projects",
                workspaceId,
                undefined,
                false,
                containerId || undefined,
              );
            }}
          />
        )}
      {configuringFields &&
        user &&
        workspace &&
        workspace.role !== "viewer" &&
        (workspace.role === "admin" ||
          configuringFields.created_by === user.id) &&
        resources.some(
          (r) =>
            r.id === configuringFields.id &&
            r.kind === "project" &&
            !r.deleted_at,
        ) && (
          <Suspense
            fallback={<p role="status">Abriendo configuración de campos…</p>}
          >
            <CustomFieldAdmin
              key={`${scopeKey}:${configuringFields.id}`}
              project={resources.find((r) => r.id === configuringFields.id)!}
              user={user}
              workspace={workspace}
              members={members}
              refresh={refresh}
              close={() =>
                setConfiguringFields((current) =>
                  current?.id === configuringFields.id ? null : current,
                )
              }
            />
          </Suspense>
        )}
      {configuringWorkflow &&
        user &&
        workspace &&
        workspace.role !== "viewer" &&
        (workspace.role === "admin" ||
          configuringWorkflow.created_by === user.id) &&
        resources.some(
          (r) =>
            r.id === configuringWorkflow.id &&
            r.kind === "project" &&
            !r.deleted_at,
        ) && (
          <Suspense
            fallback={<p role="status">Abriendo flujo de estados…</p>}
          >
            <WorkflowAdmin
              key={`${scopeKey}:${configuringWorkflow.id}`}
              project={resources.find((r) => r.id === configuringWorkflow.id)!}
              user={user}
              workspace={workspace}
              tasks={resources}
              save={save}
              close={() =>
                setConfiguringWorkflow((current) =>
                  current?.id === configuringWorkflow.id ? null : current,
                )
              }
            />
          </Suspense>
        )}
      {capturing && user && workspace && (
        <Suspense fallback={<p role="status">Abriendo captura rápida…</p>}>
          <QuickCapture
            key={`${user.id}:${workspace.id}`}
            user={user}
            canEdit={canEdit}
            workspace={workspace}
            resources={resources}
            members={members}
            initialDestination={
              page === "projects" && projectLayout === "structure"
                ? hierarchyFocusId || projectId
                : projectId
            }
            save={save}
            open={openResource}
            close={() => setCapturing(false)}
            online={online}
          />
        </Suspense>
      )}
      {command && (
        <Suspense fallback={null}>
          <CommandPalette
            resources={active}
            open={openResource}
            close={() => setCommand(false)}
            pages={[
              ...navItems.map(([key, label, Icon]) => ({
                id: `page:${key}`,
                label,
                icon: Icon,
                run: () => navigate(key),
              })),
              ...projects.map((p) => ({
                id: `project:${p.id}`,
                label: p.title,
                hint: "Proyecto",
                icon: FolderKanban,
                run: () => navigate("tasks", p.id),
              })),
            ]}
            actions={[
              ...(workspace
                ? [
                    {
                      id: "capture",
                      label: canEdit ? "Captura rápida" : "Recuperar captura local",
                      hint: "Apunta una idea, tarea o nota",
                      shortcut: "Alt+Q",
                      icon: Plus,
                      run: () => setCapturing(true),
                    },
                  ]
                : []),
              ...(canEdit
                ? [
                    {
                      id: "new-task",
                      label: selectedProject ? `Nueva tarea en ${selectedProject.title}` : "Nueva tarea",
                      icon: Plus,
                      run: () => setCreating("task"),
                    },
                    { id: "new-doc", label: "Nuevo documento", icon: FileText, run: () => setCreating("document") },
                    { id: "new-project", label: "Nuevo proyecto", icon: FolderKanban, run: () => setCreating("project") },
                  ]
                : []),
              { id: "settings", label: "Abrir configuración", icon: Settings, run: () => navigate("settings") },
            ]}
          />
        </Suspense>
      )}
      <nav aria-label="Navegación inferior" className="bottom-bar">
        {(
          [
            ["overview", "Hoy", Sun],
            ["inbox", "Bandeja", Inbox],
            ["capture", "Capturar", Plus],
            ["projects", "Proyectos", FolderKanban],
            ["search", "Buscar", Search],
          ] as const
        ).map(([key, label, Icon]) => {
          const current = key === page && !projectId;
          const unread =
            key === "inbox"
              ? active.filter(
                  (r) =>
                    r.kind === "notification" &&
                    r.data.assigneeId === user.id &&
                    !r.data.read &&
                    !(r.data.snoozedUntil && Date.parse(r.data.snoozedUntil) > Date.now()),
                ).length
              : 0;
          if (key === "capture" && !canEdit) return null;
          return (
            <button
              key={key}
              className={`bottom-bar-item ${key === "capture" ? "capture" : ""} ${current ? "active" : ""}`}
              aria-current={current ? "page" : undefined}
              aria-label={unread ? `${label}, ${unread} sin leer` : label}
              onClick={() =>
                key === "capture"
                  ? setCapturing(true)
                  : key === "search"
                    ? setCommand(true)
                    : navigate(key)
              }
            >
              <span className="bottom-bar-icon">
                <Icon size={key === "capture" ? 22 : 20} />
                {unread > 0 && <span className="bottom-bar-badge">{unread}</span>}
              </span>
              {key !== "capture" && <span>{label}</span>}
            </button>
          );
        })}
      </nav>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
    </DragProvider>
  );
}

/** A sidebar project: drop a task to move it here, or drag favorites to reorder them. */
function SidebarProject({
  project,
  selected,
  favorite,
  canEdit,
  open,
  moveTask,
  reorder,
}: {
  project: Resource;
  selected: boolean;
  favorite: boolean;
  canEdit: boolean;
  open: () => void;
  moveTask: (task: Resource) => Promise<void>;
  reorder: (id: string) => void;
}) {
  const drag = useDrag(
    `favorite:${project.id}`,
    { type: "favorite", id: project.id, label: project.title },
    !favorite,
  );
  const drop = useDrop(`project:${project.id}`, {
    accepts: (item) =>
      (item.type === "task" && canEdit && item.task.data.projectId !== project.id) ||
      (item.type === "favorite" && favorite && item.id !== project.id),
    drop: async (item) => {
      if (item.type === "task") await moveTask(item.task);
      else if (item.type === "favorite") reorder(item.id);
    },
  });
  return (
    <button
      ref={(node) => {
        drag.ref(node);
        drop.ref(node);
      }}
      className={`nav-item ${selected ? "selected" : ""} ${drop.over ? "drop-over" : ""} ${drop.armed ? "drop-armed" : ""} ${drag.dragging ? "dragging" : ""}`}
      onClick={open}
      {...drag.handle}
    >
      <span
        className="project-dot"
        style={{ background: project.data.color || "#7c4ddb" }}
      />
      <span>{project.title}</span>
    </button>
  );
}

/** Four at-a-glance numbers on Informes y tiempo: completed, overdue, open and hours this week. */
function WorkKpis({ resources, projectId }: { resources: Resource[]; projectId: string | null }) {
  const today = new Date().toLocaleDateString("en-CA");
  const monthAgo = new Date(Date.now() - 28 * 86_400_000).toISOString();
  const weekStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toLocaleDateString("en-CA");
  })();
  const tasks = resources.filter(
    (r) => r.kind === "task" && (!projectId || r.data.projectId === projectId),
  );
  const open = tasks.filter((t) => !["done", "cancelled"].includes(t.data.status));
  const completed = tasks.filter((t) => t.data.status === "done" && t.updated_at >= monthAgo).length;
  const late = open.filter((t) => t.data.dueDate && t.data.dueDate < today).length;
  const seconds = resources
    .filter((r) => r.kind === "time_entry" && r.data.timeLog && r.data.timeLog.date >= weekStart)
    .reduce((n, r) => n + (r.data.timeLog.seconds || 0), 0);
  const tiles = [
    { label: "Completadas", value: String(completed), meta: "últimas 4 semanas", tone: "tone-time" },
    { label: "Vencidas", value: String(late), meta: late ? "revisa prioridades" : "nada atrasado", tone: "tone-late" },
    { label: "Abiertas", value: String(open.length), meta: "pendientes o en curso", tone: "tone-today" },
    { label: "Horas", value: `${Math.round(seconds / 360) / 10} h`, meta: "registradas esta semana", tone: "tone-inbox" },
  ];
  return (
    <section className="today-tiles work-kpis" aria-label="Indicadores">
      {tiles.map((t) => (
        <div key={t.label} className={`today-tile ${t.tone}`}>
          <span className="today-tile-label">{t.label}</span>
          <strong>{t.value}</strong>
          <small>{t.meta}</small>
        </div>
      ))}
    </section>
  );
}
