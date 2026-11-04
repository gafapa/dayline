import { authorizeLocalUser, withLocalSessionGate } from "./local-lifecycle";
import { useLocalGuard } from "./useLocalGuard";
import { reminderTargetKinds } from "../shared/reminders";
import {
  coordinateLocalSession,
  signOutEverywhereLocal,
  LocalWorkRetained,
} from "./session-coordination";
import { ResourceLink } from "./ResourceLink";
import {
  DOCUMENT_SCHEMA_EVENT,
  DOCUMENT_SCHEMA_MESSAGE,
} from "../shared/document-protocol";
import { isStructure, structureParent } from "../shared/hierarchy";
import {
  fieldDefaults,
  applyFieldDefaults,
  fieldValueError,
  type CustomFieldValue,
} from "../shared/custom-fields";
import { ConfiguredTaskFields } from "./CustomFieldInputs";
import { resolveNavigation } from "./resolve-navigation";
import { navigationEvent, localResourceLocation } from "./navigation";
import {
  readAppRoute,
  pageHref,
  type AppPage,
  type AppRoute,
} from "../shared/navigation";
import { Field, Modal } from "./components/Primitives";
import { SecuritySettings } from "./SecuritySettings";
import { Attachments } from "./Attachments";
import { ResourceRelations } from "./ResourceRelations";
import { AutomationFields, AutomationHistory } from "./Automations";
import { isDelivery } from "../shared/delivery";
import { canManageRule } from "../shared/automation";
import {
  documentMarkdown,
  documentText,
  documentReferences,
  standaloneDocument,
  type DocumentNode,
} from "../shared/documents";
import {
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type ReactElement,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Command,
  FileText,
  Flag,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Target,
  Trash2,
  Users,
  WifiOff,
  X,
  History,
  Link2,
  Layers,
  Clock3,
  Sun,
} from "lucide-react";
import { api, ApiError, send } from "./api";
import {
  cacheSnapshot,
  beginSnapshotRead,
  flushOutbox,
  localSnapshot,
  pendingOperations,
  queueMutation,
  resolveConflict,
  rememberSession,
  rememberedSession,
  forgetSession,
} from "./storage";
import {
  kindLabels,
  statusLabels,
  sprintStats,
  taskStatuses,
  type Resource,
  type ResourceKind,
  type User,
  type Workspace,
} from "../shared/model";
const CollaborativeEditor = lazy(() => import("./CollaborativeEditor"));
const ProjectStructure = lazy(() => import("./ProjectStructure"));
const CustomFieldAdmin = lazy(() => import("./CustomFieldAdmin"));
const WorkflowAdmin = lazy(() => import("./WorkflowAdmin"));
const WorkspaceManager = lazy(() => import("./WorkspaceManager"));
const PlatformAdmin = lazy(() => import("./PlatformAdmin"));
const Setup = lazy(() => import("./Setup"));
import WorkflowStateSelect from "./WorkflowStateSelect";
import Today from "./Today";
import { normalizeTaskState } from "../shared/workflow";
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
/** Six daily destinations; each groups related pages shown as section tabs. */
const navGroups: { label: string; icon: any; pages: Page[] }[] = [
  { label: "Hoy", icon: Sun, pages: ["overview", "reminders"] },
  { label: "Bandeja", icon: Inbox, pages: ["inbox"] },
  { label: "Tareas", icon: CircleCheck, pages: ["my_tasks", "tasks", "calendar"] },
  { label: "Proyectos", icon: FolderKanban, pages: ["projects"] },
  { label: "Documentos", icon: FileText, pages: ["documents", "notes", "templates"] },
  { label: "Planificar", icon: Flag, pages: ["sprints", "planning", "reports", "time"] },
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
const pageGroup = (page: Page) =>
  navGroups.find((group) => group.pages.includes(page))?.pages ||
  (settingsPages.includes(page) ? settingsPages : [page]);
const dateText = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(
        new Date(value),
      )
    : "Sin fecha";
const initialData = (
  kind: ResourceKind,
  projectId?: string,
): Record<string, any> => ({
  ...(["task", "project", "sprint"].includes(kind)
    ? {
        status:
          kind === "task"
            ? "backlog"
            : kind === "sprint"
              ? "planned"
              : "active",
      }
    : {}),
  ...(kind === "task"
    ? { priority: "medium", labels: [], estimate: 0, checklist: [] }
    : {}),
  ...(projectId && kind !== "project" ? { projectId } : {}),
  description: "",
});

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
    [schemaIncompatible, setSchemaIncompatible] = useState(false),
    [syncing, setSyncing] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [logoutRetention, setLogoutRetention] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [loading, setLoading] = useState(true);
  const pending = loadedScope.current === scopeKey ? pendingState : [];
  const workspace = workspaces.find((w) => w.id === workspaceId),
    canEdit = !schemaIncompatible && workspace?.role !== "viewer";
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
  useEffect(() => {
    const mismatch = () => {
      setSchemaIncompatible(true);
      setError(DOCUMENT_SCHEMA_MESSAGE);
    };
    window.addEventListener(DOCUMENT_SCHEMA_EVENT, mismatch);
    return () => window.removeEventListener(DOCUMENT_SCHEMA_EVENT, mismatch);
  }, []);
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
      await withLocalSessionGate(session.user.id, async () => {
        if (generation !== localStorage.getItem("kelvin-auth-generation"))
          return;
        authorizeLocalUser(session.user.id);
        await rememberSession(session);
        if (generation !== localStorage.getItem("kelvin-auth-generation"))
          return;
        apply(session);
      });
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
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
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
        setCommand(false);
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

  if (!user && schemaIncompatible)
    return (
      <main className="auth-shell">
        <div role="alert">
          <p>{DOCUMENT_SCHEMA_MESSAGE}</p>
          <button
            type="button"
            className="schema-refresh"
            onClick={() => location.reload()}
          >
            Actualizar aplicación
          </button>
        </div>
      </main>
    );
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
    <div className="app-shell">
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
          {navGroups.map(({ label, icon: Icon, pages }) => {
            const count =
              label === "Tareas"
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
                        !r.data.read,
                    ).length
                  : 0;
            const current =
              pages.includes(page) && (!projectId || label === "Tareas");
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
        </nav>
        {projects.length > 0 && (
          <div className="project-nav">
            <p className="nav-group">
              {(preferences.favorites || []).some((id: string) =>
                projects.some((p) => p.id === id),
              )
                ? "Favoritos"
                : "Proyectos recientes"}
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
              const favorites = projects.filter((p) =>
                (preferences.favorites || []).includes(p.id),
              );
              return (favorites.length ? favorites : projects).slice(0, 6);
            })().map((p) => (
              <button
                className={`nav-item ${projectId === p.id ? "selected" : ""}`}
                key={p.id}
                onClick={() => navigate("tasks", p.id)}
              >
                <span
                  className="project-dot"
                  style={{ background: p.data.color || "#7c4ddb" }}
                />
                <span>{p.title}</span>
              </button>
            ))}
          </div>
        )}
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
                  ? "Sin conexión"
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
        <main id="main" className="sheet">
          {!selectedProject && pageGroup(page).length > 1 && (
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
          {(error || schemaIncompatible) && (
            <div className="notice error" role="alert">
              <span>
                {schemaIncompatible ? DOCUMENT_SCHEMA_MESSAGE : error}
              </span>
              {logoutRetention && !schemaIncompatible && (
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
              {schemaIncompatible ? (
                <button
                  type="button"
                  className="schema-refresh"
                  onClick={() => location.reload()}
                >
                  Actualizar aplicación
                </button>
              ) : (
                <button aria-label="Cerrar aviso" onClick={() => setError("")}>
                  <X size={16} />
                </button>
              )}
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
                <Calendar tasks={tasks} open={openResource} />
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
                <>
                  <div className="document-list">
                    {active
                      .filter(
                        (r) =>
                          r.kind === "notification" &&
                          r.data.assigneeId === user.id,
                      )
                      .map((r) => (
                        <div className="document-row" key={r.id}>
                          <Bell size={18} />
                          <div>
                            <strong>{r.title}</strong>
                            <p>{r.data.description}</p>
                            {r.data.targetId &&
                              active.find(
                                (target) => target.id === r.data.targetId,
                              ) && (
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    openResource(
                                      active.find(
                                        (target) =>
                                          target.id === r.data.targetId,
                                      )!,
                                    )
                                  }
                                >
                                  Abrir elemento del aviso
                                </button>
                              )}
                          </div>
                          <button
                            onClick={() =>
                              void save({
                                ...r,
                                data: { ...r.data, read: true },
                              })
                            }
                            disabled={r.data.read}
                          >
                            {r.data.read ? "Leída" : "Marcar leída"}
                          </button>
                        </div>
                      ))}
                  </div>
                  {!active.some(
                    (r) =>
                      r.kind === "notification" &&
                      r.data.assigneeId === user.id,
                  ) && (
                    <Empty
                      icon={Inbox}
                      title="Todo al día"
                      description="Aquí encontrarás las novedades que requieren tu atención."
                    />
                  )}
                </>
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
        <Modal
          title="Buscar en tu espacio"
          close={() => setCommand(false)}
          className="command-dialog"
        >
          <SearchField value={query} set={setQuery} autoFocus />
          <div className="command-results">
            {workspace &&
              (!query || "captura rápida".includes(query.toLowerCase())) && (
                <button
                  onClick={() => {
                    setCommand(false);
                    setCapturing(true);
                  }}
                >
                  <Plus size={17} />
                  <strong>
                    {canEdit ? "Captura rápida" : "Recuperar captura local"}
                  </strong>
                  <span>Alt+Q</span>
                </button>
              )}
            {query
              ? active
                  .filter((r) =>
                    `${r.title} ${r.data.description || ""}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .slice(0, 30)
                  .map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setCommand(false);
                        openResource(r);
                      }}
                    >
                      <span>{kindLabels[r.kind]}</span>
                      <strong>{r.title}</strong>
                      <ArrowRight size={14} />
                    </button>
                  ))
              : navItems.map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => {
                      setCommand(false);
                      navigate(key);
                    }}
                  >
                    <Icon size={17} />
                    {label}
                    <ArrowRight size={14} />
                  </button>
                ))}
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

/** Sets a new password from a single-use link created by platform administration. */
function PasswordReset({ token, done }: { token: string; done: () => void }) {
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  return (
    <div className="auth-page auth-reset">
      <div className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget),
              newPassword = String(data.get("newPassword") || ""),
              repeat = String(data.get("repeat") || "");
            setIssue("");
            if (newPassword !== repeat) {
              setIssue("Las dos contraseñas no coinciden.");
              return;
            }
            setBusy(true);
            try {
              await api("/account/reset", send({ token, newPassword }));
              done();
            } catch (e) {
              setIssue((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <a className="brand" href="/">
            <img src="/mark.svg" alt="" />
            Dayline
          </a>
          <h2>Nueva contraseña</h2>
          <p>
            Elige una contraseña de al menos 8 caracteres. Se cerrarán todas
            tus sesiones abiertas.
          </p>
          {issue && (
            <div className="notice error" role="alert">
              {issue}
            </div>
          )}
          <Field label="Nueva contraseña">
            <input
              name="newPassword"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label="Repite la contraseña">
            <input
              name="repeat"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
            />
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            Guardar contraseña
          </button>
        </form>
      </div>
    </div>
  );
}

function Auth({
  boot,
  error,
  ready,
}: {
  boot: any;
  error: string;
  ready: () => void;
}) {
  const invitation = new URLSearchParams(location.search).get("invitation");
  const setup = boot?.setupRequired && !invitation;
  const [busy, setBusy] = useState(false),
    [localError, setLocalError] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false),
    [recovering, setRecovering] = useState(false),
    [useRecovery, setUseRecovery] = useState(false),
    [recovered, setRecovered] = useState(false),
    [resetToken, setResetToken] = useState(() =>
      new URLSearchParams(location.search).get("reset"),
    ),
    [resetDone, setResetDone] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setLocalError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(
        recovering
          ? "/account/recover"
          : invitation
            ? "/invitations/accept"
            : setup
              ? "/setup"
              : "/login",
        send({ ...data, ...(invitation ? { token: invitation } : {}) }),
      );
      if (recovering) {
        setRecovering(false);
        setRecovered(true);
        setMfaRequired(false);
        event.currentTarget?.reset();
      } else {
        history.replaceState({}, "", location.pathname);
        ready();
      }
    } catch (e) {
      setLocalError((e as Error).message);
      if (e instanceof ApiError && e.detail?.mfaRequired) setMfaRequired(true);
    } finally {
      setBusy(false);
    }
  };
  if (setup)
    return (
      <Suspense fallback={null}>
        <Setup boot={boot} ready={ready} />
      </Suspense>
    );
  if (resetToken)
    return (
      <PasswordReset
        token={resetToken}
        done={() => {
          history.replaceState({}, "", location.pathname);
          setResetToken(null);
          setResetDone(true);
        }}
      />
    );
  return (
    <div className="auth-page">
      <div className="auth-intro">
        <a className="brand" href="/">
          <img src="/mark.svg" alt="" />
          Dayline
        </a>
        <div>
          <span className="eyebrow">Menos dispersión. Más claridad.</span>
          <h1>
            Del primer apunte
            <br />
            al próximo sprint.
          </h1>
          <p>
            Documentos, proyectos y personas.
            <br />
            Todo lo que necesitas para avanzar juntos.
          </p>
          <div className="auth-path">
            <span>
              <FileText size={18} />
              Documenta
            </span>
            <ChevronRight size={16} />
            <span>
              <Layers size={18} />
              Organiza
            </span>
            <ChevronRight size={16} />
            <span>
              <Target size={18} />
              Avanza
            </span>
          </div>
        </div>
        <small>Tu trabajo conserva su contexto.</small>
      </div>
      <div className="auth-form-wrap">
        <form onSubmit={submit} className="auth-form">
          <h2>
            {invitation
              ? "Únete al equipo"
              : setup
                ? "Crea tu espacio"
                : "Vuelve a tu espacio"}
          </h2>
          <p>
            {invitation
              ? "Completa tu cuenta para aceptar la invitación."
              : setup
                ? "Empieza con un espacio propio y añade a tu equipo."
                : "Inicia sesión para continuar con tu trabajo."}
          </p>
          {(error || localError) && (
            <div className="notice error" role="alert">
              {localError || error}
            </div>
          )}
          {resetDone && !localError && (
            <p className="notice" role="status">
              Contraseña actualizada. Inicia sesión con la nueva contraseña.
            </p>
          )}
          {(setup || invitation) && (
            <Field label="Tu nombre">
              <input name="name" required autoComplete="name" maxLength={100} />
            </Field>
          )}
          <Field label="Correo electrónico">
            <input name="email" type="email" required autoComplete="username" />
          </Field>
          {recovered && (
            <p role="status">
              Contraseña actualizada. Inicia sesión; la verificación en dos
              pasos sigue activa si la habías configurado.
            </p>
          )}
          <Field label={recovering ? "Nueva contraseña" : "Contraseña"}>
            <input
              name={recovering ? "newPassword" : "password"}
              type="password"
              minLength={8}
              maxLength={200}
              required
              autoComplete={
                setup || invitation || recovering
                  ? "new-password"
                  : "current-password"
              }
            />
          </Field>
          {((mfaRequired && !useRecovery) || false) && !recovering && (
            <Field label="Código de autenticación">
              <input
                name="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
              />
            </Field>
          )}
          {(recovering || (mfaRequired && useRecovery)) && (
            <Field label="Código de recuperación">
              <input name="recoveryCode" autoComplete="off" required />
            </Field>
          )}
          {mfaRequired && !recovering && (
            <button
              className="text-button"
              type="button"
              onClick={() => setUseRecovery(!useRecovery)}
            >
              {useRecovery
                ? "Usar el autenticador"
                : "Usar un código de recuperación"}
            </button>
          )}
          {(setup || invitation) && (
            <small>Utiliza al menos 8 caracteres.</small>
          )}
          {setup && (
            <Field label="Nombre del espacio">
              <input
                name="workspaceName"
                required
                defaultValue="Mi equipo"
                maxLength={100}
              />
            </Field>
          )}
          {setup && boot.setupTokenRequired && (
            <Field label="Código de configuración">
              <input
                name="setupToken"
                type="password"
                required
                autoComplete="off"
              />
            </Field>
          )}
          <button className="primary" disabled={busy || !boot}>
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            {recovering
              ? "Recuperar cuenta"
              : invitation
                ? "Aceptar invitación"
                : setup
                  ? "Crear espacio"
                  : "Entrar"}
            <ArrowRight size={16} />
          </button>
          {!setup && !invitation && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setRecovering(!recovering);
                setLocalError("");
                setRecovered(false);
              }}
            >
              {recovering
                ? "Volver al inicio de sesión"
                : "Recuperar con un código de seguridad"}
            </button>
          )}
          <small>El acceso al equipo se realiza mediante invitación.</small>
        </form>
      </div>
    </div>
  );
}

function SprintProgress({ tasks }: { tasks: Resource[] }) {
  const stats = sprintStats(tasks);
  return (
    <>
      <div className="progress-track">
        <span style={{ width: `${stats.percent}%` }} />
      </div>
      <div className="project-footer">
        <span>
          {stats.done} de {stats.total} tareas completadas
        </span>
        <span>{stats.percent}%</span>
      </div>
    </>
  );
}
function StatusIcon({ status }: { status: string }) {
  const Icon =
    status === "done"
      ? CircleCheck
      : status === "in_progress"
        ? CircleDot
        : status === "review"
          ? Clock3
          : Circle;
  return <Icon className={`status-icon ${status}`} size={17} />;
}

function CreateDialog({
  kind,
  projects,
  sprints,
  members,
  projectId,
  close,
  submit,
}: any) {
  const [busy, setBusy] = useState(false),
    [localError, setLocalError] = useState("");
  const [creationProject, setCreationProject] = useState(projectId || ""),
    [taskFields, setTaskFields] = useState<Record<string, CustomFieldValue>>(
      {},
    );
  const definitions =
    projects.find((r: Resource) => r.id === creationProject)?.data
      .fieldDefinitions || [];
  return (
    <Modal
      title={`Crear ${kindLabels[kind as ResourceKind].toLowerCase()}`}
      close={close}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          setLocalError("");
          try {
            await submit(String(f.get("title")), {
              ...initialData(kind, projectId || undefined),
              description: String(f.get("description") || ""),
              ...(f.get("projectId") ? { projectId: f.get("projectId") } : {}),
              ...(kind === "task"
                ? {
                    assigneeId: f.get("assigneeId") || null,
                    sprintId: f.get("sprintId") || null,
                    customFields: {
                      ...fieldDefaults(definitions),
                      ...taskFields,
                    },
                  }
                : {}),
              ...(kind === "sprint"
                ? {
                    goal: f.get("description"),
                    startDate: f.get("startDate") || "",
                    endDate: f.get("endDate") || "",
                  }
                : {}),
            });
          } catch (error) {
            setLocalError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {localError && <p role="alert">{localError}</p>}
        <Field label="Título">
          <input name="title" required autoFocus maxLength={500} />
        </Field>
        <Field
          label={kind === "sprint" ? "Objetivo del sprint" : "Descripción"}
        >
          <textarea name="description" rows={3} />
        </Field>
        {!["project", "team", "sprint"].includes(kind) && (
          <Field label="Proyecto">
            <select
              name="projectId"
              value={creationProject}
              onChange={(e) => {
                setCreationProject(e.target.value);
                setTaskFields({});
              }}
            >
              <option value="">Sin proyecto</option>
              {projects.map((p: Resource) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind === "task" && (
          <div className="form-grid">
            <Field label="Responsable">
              <select name="assigneeId">
                <option value="">Sin asignar</option>
                {members.map((m: any) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sprint">
              <select name="sprintId">
                <option value="">Backlog</option>
                {sprints
                  .filter((s: Resource) => s.data.status !== "completed")
                  .map((s: Resource) => (
                    <option value={s.id} key={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        )}
        {kind === "sprint" && (
          <div className="form-grid">
            <Field label="Inicio">
              <input type="date" name="startDate" />
            </Field>
            <Field label="Fin">
              <input type="date" name="endDate" />
            </Field>
          </div>
        )}
        {kind === "task" && (
          <ConfiguredTaskFields
            definitions={definitions}
            values={{ ...fieldDefaults(definitions), ...taskFields }}
            change={setTaskFields}
            editable
            members={members}
            required
          />
        )}
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy
              ? "Guardando…"
              : "Crear " + kindLabels[kind as ResourceKind].toLowerCase()}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResourceDialog({
  resource,
  resources,
  members,
  canEdit,
  workspaceId,
  user,
  workspaceRole,
  close,
  save,
  create,
  open,
  error,
  notify,
  navigationGuard,
  showStructure,
  requestReminder,
}: any) {
  const [draft, setDraft] = useState<Resource>(resource),
    [dirty, setDirty] = useState(false),
    [tab, setTab] = useState(isDelivery(resource) ? "comments" : "details"),
    [versions, setVersions] = useState<any[]>([]),
    [comment, setComment] = useState(""),
    [busy, setBusy] = useState(false);
  useLocalGuard(
    dirty || busy || comment.trim()
      ? "Hay cambios o un comentario sin guardar. Guárdalos antes de cerrar sesión."
      : "",
  );
  const liveContent = useRef<DocumentNode>(
    resource.data.content || { type: "doc", content: [{ type: "paragraph" }] },
  );
  const [exportFormat, setExportFormat] = useState("markdown"),
    [documentRevisions, setDocumentRevisions] = useState<any[]>([]),
    [restoration, setRestoration] = useState<{
      revision: string;
      content: DocumentNode;
    }>(),
    [comparison, setComparison] = useState<any>(null);
  const exportDocument = async () => {
    const content = structuredClone(liveContent.current);
    const preview = exportFormat === "pdf" ? window.open("", "_blank") : null;
    try {
      if (exportFormat === "html" || exportFormat === "pdf") {
        const embed = async (node: DocumentNode): Promise<void> => {
          if (
            node.type === "image" &&
            String(node.attrs?.src || "").startsWith("/api/")
          ) {
            const response = await fetch(node.attrs!.src, {
              credentials: "same-origin",
            });
            if (!response.ok)
              throw new Error(
                "No se pudo incorporar una imagen a la exportación.",
              );
            const blob = await response.blob();
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            node.attrs = { ...node.attrs, src: data };
          }
          for (const child of node.content || []) await embed(child);
        };
        await embed(content);
      }
      if (exportFormat === "json")
        download(
          `${draft.title}.json`,
          JSON.stringify(
            { ...draft, data: { ...draft.data, content } },
            null,
            2,
          ),
          "application/json",
        );
      else if (exportFormat === "markdown")
        download(
          `${draft.title}.md`,
          "# " + draft.title + "\n\n" + documentMarkdown(content),
          "text/markdown",
        );
      else if (exportFormat === "html")
        download(
          `${draft.title}.html`,
          standaloneDocument(draft.title, content),
          "text/html",
        );
      else if (preview) {
        preview.opener = null;
        preview.document.write(standaloneDocument(draft.title, content));
        preview.document.close();
        await Promise.all(
          [...preview.document.images].map((image) =>
            image.decode().catch(() => {}),
          ),
        );
        preview.print();
      }
    } catch (e) {
      preview?.close();
      error((e as Error).message);
    }
  };
  const setData = (patch: any) => {
    setDraft((d) => ({ ...d, data: { ...d.data, ...patch } }));
    setDirty(true);
  };
  useEffect(() => {
    if (!dirty) setDraft(resource);
  }, [resource.version, dirty]);
  const persist = async () => {
    setBusy(true);
    try {
      await save(draft);
      setDirty(false);
      notify("Cambios guardados en este dispositivo.");
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const guard = () =>
      !dirty ||
      confirm("Hay cambios sin guardar. ¿Salir sin guardar estos cambios?");
    if (navigationGuard) navigationGuard.current = guard;
    return () => {
      if (navigationGuard?.current === guard)
        navigationGuard.current = () => true;
    };
  }, [dirty, navigationGuard]);
  const requestClose = () => {
    if (
      dirty &&
      !confirm("Hay cambios sin guardar. ¿Cerrar sin guardar estos cambios?")
    )
      return;
    close();
  };
  const projects = resources.filter((r: Resource) => r.kind === "project"),
    sprints = resources.filter(
      (r: Resource) => r.kind === "sprint" && r.data.status !== "completed",
    ),
    comments = resources.filter(
      (r: Resource) => r.kind === "comment" && r.data.targetId === resource.id,
    ),
    linked = resources.filter(
      (r: Resource) =>
        r.data.projectId === resource.id || r.data.parentId === resource.id,
    );
  const frozen =
    resource.kind === "sprint" && resource.data.status === "completed";
  const editable =
    canEdit &&
    !isDelivery(resource) &&
    !frozen &&
    (resource.kind !== "automation" ||
      canManageRule(resource, user.id, workspaceRole));
  return (
    <Modal
      title={
        resource.data.personalNote
          ? "Nota personal"
          : kindLabels[resource.kind as ResourceKind]
      }
      close={requestClose}
      className="resource-dialog"
    >
      {resource.data.personalNote && (
        <p className="personal-note-status" role="status">
          Nota personal · Solo tu cuenta puede consultarla en la aplicación.
        </p>
      )}
      <div className="resource-top">
        <input
          className="resource-title"
          aria-label="Título"
          value={draft.title}
          readOnly={!editable}
          onChange={(e) => {
            setDraft({ ...draft, title: e.target.value });
            setDirty(true);
          }}
        />
        <span className="resource-id">
          {resource.id.slice(0, 8)} · v{resource.version}
        </span>
      </div>
      <div className="view-tabs detail-tabs">
        <button
          className={tab === "details" ? "active" : ""}
          onClick={() => setTab("details")}
        >
          Detalles
        </button>
        <button
          className={tab === "comments" ? "active" : ""}
          onClick={() => setTab("comments")}
        >
          Comentarios · {comments.length}
        </button>
        <button
          className={tab === "history" ? "active" : ""}
          onClick={async () => {
            setTab("history");
            try {
              setVersions(
                (
                  await api(
                    `/workspaces/${workspaceId}/resources/${resource.id}/versions`,
                  )
                ).versions,
              );
            } catch (e) {
              error((e as Error).message);
            }
          }}
        >
          Historial
        </button>
      </div>
      <div className="modal-body">
        {tab === "details" && (
          <>
            {draft.kind === "automation" && (
              <AutomationFields
                draft={draft}
                members={members}
                editable={editable}
                setData={setData}
              />
            )}
            {resource.kind === "document" ? (
              <Suspense fallback={<p>Abriendo editor…</p>}>
                <CollaborativeEditor
                  documentId={resource.id}
                  documentSchemaVersion={
                    resource.data.documentSchemaVersion ?? 1
                  }
                  hasServerContent={
                    !!resource.data.content?.content?.some(
                      (node: any) =>
                        node.type !== "paragraph" || node.content?.length,
                    )
                  }
                  workspaceId={workspaceId}
                  user={user}
                  editable={editable}
                  onContent={(content) => {
                    liveContent.current = content;
                  }}
                  restore={restoration}
                />
              </Suspense>
            ) : (
              <Field
                label={resource.kind === "sprint" ? "Objetivo" : "Descripción"}
              >
                <textarea
                  value={
                    resource.kind === "sprint"
                      ? draft.data.goal || ""
                      : draft.data.description || ""
                  }
                  readOnly={!editable}
                  rows={4}
                  onChange={(e) =>
                    setData(
                      resource.kind === "sprint"
                        ? { goal: e.target.value }
                        : { description: e.target.value },
                    )
                  }
                />
              </Field>
            )}
            {resource.data.personalNote && (
              <Field label="Resumen de la nota">
                <textarea
                  rows={3}
                  maxLength={100000}
                  readOnly={!editable}
                  value={draft.data.description || ""}
                  onChange={(event) =>
                    setData({ description: event.target.value })
                  }
                />
              </Field>
            )}
            <div className="form-grid">
              {["task", "project", "sprint"].includes(resource.kind) && (
                <Field label="Estado">
                  {resource.kind === "task" ? (
                    <WorkflowStateSelect
                      disabled={!editable}
                      task={draft}
                      projects={resources}
                      onChange={(data) =>
                        setData({ status: data.status, stateId: data.stateId ?? null })
                      }
                    />
                  ) : (
                  <select
                    disabled={!editable}
                    value={draft.data.status || ""}
                    onChange={(e) => setData({ status: e.target.value })}
                  >
                    {(resource.kind === "task"
                      ? taskStatuses
                      : resource.kind === "sprint"
                        ? ["planned", "active", "completed"]
                        : ["active", "paused", "completed"]
                    ).map((s) => (
                      <option
                        value={s}
                        key={s}
                        disabled={
                          resource.kind === "sprint" && s === "completed"
                        }
                      >
                        {statusLabels[s]}
                      </option>
                    ))}
                  </select>
                  )}
                </Field>
              )}
              {resource.kind !== "project" && !resource.data.personalNote && (
                <Field label="Proyecto">
                  <select
                    disabled={!editable || isStructure(resource)}
                    value={draft.data.projectId || ""}
                    onChange={(e) =>
                      setData({ projectId: e.target.value || null })
                    }
                  >
                    <option value="">Sin proyecto</option>
                    {projects.map((p: Resource) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {isStructure(resource) && showStructure && (
                <div className="field">
                  <span>Ubicación en la estructura</span>
                  <button type="button" onClick={() => showStructure(resource)}>
                    Organizar ubicación
                  </button>
                  <small>
                    Los movimientos se revisan antes de cambiar la ubicación o
                    el proyecto.
                  </small>
                </div>
              )}
              {resource.kind === "task" && (
                <>
                  <Field label="Responsable">
                    <select
                      disabled={!editable}
                      value={draft.data.assigneeId || ""}
                      onChange={(e) =>
                        setData({ assigneeId: e.target.value || null })
                      }
                    >
                      <option value="">Sin asignar</option>
                      {members.map((m: any) => (
                        <option value={m.id} key={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Prioridad">
                    <select
                      disabled={!editable}
                      value={draft.data.priority || "medium"}
                      onChange={(e) => setData({ priority: e.target.value })}
                    >
                      {[
                        ["none", "Sin prioridad"],
                        ["low", "Baja"],
                        ["medium", "Media"],
                        ["high", "Alta"],
                        ["urgent", "Urgente"],
                      ].map(([v, l]) => (
                        <option value={v} key={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Sprint">
                    <select
                      disabled={!editable}
                      value={draft.data.sprintId || ""}
                      onChange={(e) =>
                        setData({ sprintId: e.target.value || null })
                      }
                    >
                      <option value="">Backlog</option>
                      {sprints.map((s: Resource) => (
                        <option value={s.id} key={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Estimación en puntos">
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value={draft.data.estimate || 0}
                      readOnly={!editable}
                      onChange={(e) =>
                        setData({ estimate: Number(e.target.value) })
                      }
                    />
                  </Field>
                </>
              )}
              <Field
                label={
                  resource.kind === "sprint"
                    ? "Fecha de inicio"
                    : "Fecha límite"
                }
              >
                <input
                  type="date"
                  value={
                    resource.kind === "sprint"
                      ? draft.data.startDate || ""
                      : draft.data.dueDate || ""
                  }
                  readOnly={!editable}
                  onChange={(e) =>
                    setData(
                      resource.kind === "sprint"
                        ? { startDate: e.target.value }
                        : { dueDate: e.target.value },
                    )
                  }
                />
              </Field>
              {resource.kind === "sprint" && (
                <Field label="Fecha de fin">
                  <input
                    type="date"
                    value={draft.data.endDate || ""}
                    readOnly={!editable}
                    onChange={(e) => setData({ endDate: e.target.value })}
                  />
                </Field>
              )}
            </div>
            {resource.kind === "task" && (
              <>
                <Field label="Etiquetas, separadas por comas">
                  <input
                    readOnly={!editable}
                    value={(draft.data.labels || []).join(", ")}
                    onChange={(e) =>
                      setData({
                        labels: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
                <Field label="Criterios de aceptación">
                  <textarea
                    rows={3}
                    readOnly={!editable}
                    value={draft.data.acceptance || ""}
                    onChange={(e) => setData({ acceptance: e.target.value })}
                  />
                </Field>
                <h3>Lista de comprobación</h3>
                {(draft.data.checklist || []).map((item: any) => (
                  <label className="checklist-item" key={item.id}>
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={!editable}
                      onChange={(e) =>
                        setData({
                          checklist: draft.data.checklist.map((c: any) =>
                            c.id === item.id
                              ? { ...c, done: e.target.checked }
                              : c,
                          ),
                        })
                      }
                    />
                    <span>{item.text}</span>
                  </label>
                ))}
                {editable && (
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const text = String(
                        new FormData(form).get("item") || "",
                      ).trim();
                      if (text)
                        setData({
                          checklist: [
                            ...(draft.data.checklist || []),
                            { id: crypto.randomUUID(), text, done: false },
                          ],
                        });
                      form.reset();
                    }}
                  >
                    <input
                      name="item"
                      aria-label="Nuevo punto de comprobación"
                      placeholder="Añadir un punto…"
                      maxLength={500}
                    />
                    <button aria-label="Añadir punto">
                      <Plus size={16} />
                    </button>
                  </form>
                )}
              </>
            )}
            {resource.kind === "project" && (
              <>
                <Field label="Repositorio">
                  <input
                    type="url"
                    value={draft.data.repository || ""}
                    readOnly={!editable}
                    onChange={(e) => setData({ repository: e.target.value })}
                  />
                </Field>
                <label className="checklist-item">
                  <input
                    type="checkbox"
                    checked={draft.data.private || false}
                    disabled={!editable}
                    onChange={(e) => setData({ private: e.target.checked })}
                  />
                  Proyecto privado
                </label>
                {draft.data.private && (
                  <Field label="Miembros con acceso">
                    <select
                      multiple
                      value={draft.data.members || []}
                      disabled={!editable}
                      onChange={(e) =>
                        setData({
                          members: [...e.target.selectedOptions].map(
                            (o) => o.value,
                          ),
                        })
                      }
                    >
                      {members.map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            )}
            {resource.kind === "sprint" && (
              <>
                <Field label="Definición de terminado">
                  <textarea
                    value={draft.data.definitionOfDone || ""}
                    readOnly={!editable}
                    rows={3}
                    onChange={(e) =>
                      setData({ definitionOfDone: e.target.value })
                    }
                  />
                </Field>
                <h3>Tareas del sprint</h3>
                {resources
                  .filter(
                    (r: Resource) =>
                      r.kind === "task" && r.data.sprintId === resource.id,
                  )
                  .map((r: Resource) => (
                    <button
                      className="linked-row"
                      key={r.id}
                      onClick={() => open(r)}
                    >
                      <StatusIcon status={r.data.status} />
                      {r.title}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                {frozen && (
                  <p className="notice">
                    Este sprint conserva una fotografía de{" "}
                    {(resource.data.snapshot || []).length} tareas al cerrarse.
                  </p>
                )}
              </>
            )}
            {linked.length > 0 && (
              <section>
                <h3>Elementos relacionados</h3>
                {linked.map((r: Resource) => (
                  <button
                    className="linked-row"
                    key={r.id}
                    onClick={() => open(r)}
                  >
                    <span>{kindLabels[r.kind]}</span>
                    {r.title}
                    <ArrowRight size={14} />
                  </button>
                ))}
              </section>
            )}
          </>
        )}
        {tab === "comments" && (
          <>
            <div className="comments">
              {comments.map((c: Resource) => (
                <article key={c.id}>
                  <div>
                    <span className="avatar small">
                      {members
                        .find((m: any) => m.id === c.created_by)
                        ?.name?.slice(0, 2)
                        .toUpperCase()}
                    </span>
                    <strong>
                      {members.find((m: any) => m.id === c.created_by)?.name ||
                        "Miembro"}
                    </strong>
                    <time>{dateText(c.created_at)}</time>
                  </div>
                  <p>{c.data.description}</p>
                </article>
              ))}
              {!comments.length && (
                <p className="muted">
                  Aún no hay comentarios. Comparte una pregunta o una decisión.
                </p>
              )}
            </div>
            {canEdit && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!comment.trim()) return;
                  await create("comment", `Comentario en ${resource.title}`, {
                    description: comment,
                    targetId: resource.id,
                    ...(resource.data.projectId
                      ? { projectId: resource.data.projectId }
                      : resource.kind === "project"
                        ? { projectId: resource.id }
                        : {}),
                  });
                  setComment("");
                }}
              >
                <Field label="Añadir comentario">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    required
                    rows={3}
                  />
                </Field>
                <div className="mention-controls">
                  <span>Mencionar:</span>
                  {members.slice(0, 12).map((member: any) => (
                    <button
                      type="button"
                      className="text-button"
                      key={member.id}
                      onClick={() =>
                        setComment((value) => value + ` @${member.email} `)
                      }
                    >
                      {member.name}
                    </button>
                  ))}
                </div>
                <button className="primary">Comentar</button>
              </form>
            )}
          </>
        )}
        {tab === "history" && (
          <div className="history-list">
            {resource.kind === "document" && (
              <section>
                <div className="section-heading">
                  <h3>Versiones del contenido</h3>
                  <button
                    onClick={async () => {
                      try {
                        setDocumentRevisions(
                          (
                            await api(
                              `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                            )
                          ).revisions,
                        );
                      } catch (e) {
                        error((e as Error).message);
                      }
                    }}
                  >
                    Consultar versiones
                  </button>
                </div>
                {editable && (
                  <button
                    onClick={async () => {
                      try {
                        await api(
                          `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                          send({}),
                        );
                        setDocumentRevisions(
                          (
                            await api(
                              `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                            )
                          ).revisions,
                        );
                        notify("Versión del servidor conservada.");
                      } catch (e) {
                        error((e as Error).message);
                      }
                    }}
                  >
                    Conservar versión actual del servidor
                  </button>
                )}
                {documentRevisions.map((revision) => (
                  <article key={revision.id}>
                    <div>
                      <strong>Contenido · {revision.author || "Equipo"}</strong>
                      <time>
                        {new Date(revision.created_at).toLocaleString("es")}
                      </time>
                    </div>
                    <p>
                      {documentText(revision.content).slice(0, 220) ||
                        "Documento vacío"}
                    </p>
                    <button onClick={() => setComparison(revision)}>
                      Comparar con el contenido actual
                    </button>
                    {editable && (
                      <button
                        onClick={async () => {
                          if (
                            !confirm(
                              "¿Restaurar esta versión del contenido? Se guardará antes una copia de la versión actual del servidor.",
                            )
                          )
                            return;
                          try {
                            await api(
                              `/workspaces/${workspaceId}/documents/${resource.id}/revisions`,
                              send({}),
                            );
                            setRestoration({
                              revision: String(revision.id) + "-" + Date.now(),
                              content: revision.content,
                            });
                            setTab("details");
                          } catch (e) {
                            error((e as Error).message);
                          }
                        }}
                      >
                        Restaurar contenido
                      </button>
                    )}
                  </article>
                ))}
                {comparison && (
                  <div className="revision-comparison">
                    <h3>Comparación de contenido</h3>
                    <div>
                      <section>
                        <h4>Versión seleccionada</h4>
                        <pre>{documentText(comparison.content)}</pre>
                      </section>
                      <section>
                        <h4>Contenido actual en este dispositivo</h4>
                        <pre>{documentText(liveContent.current)}</pre>
                      </section>
                    </div>
                    <button onClick={() => setComparison(null)}>
                      Cerrar comparación
                    </button>
                  </div>
                )}
              </section>
            )}
            {versions.map((v) => (
              <article key={v.version}>
                <div>
                  <strong>Versión {v.version}</strong>
                  <span>{new Date(v.created_at).toLocaleString("es")}</span>
                </div>
                <p>{v.snapshot.title}</p>
                {editable && v.version !== resource.version && (
                  <button
                    onClick={() => {
                      setDraft({
                        ...resource,
                        title: v.snapshot.title,
                        data: v.snapshot.data,
                      });
                      setDirty(true);
                      setTab("details");
                    }}
                  >
                    Revisar esta versión
                  </button>
                )}
              </article>
            ))}
            {!versions.length && <p>No hay versiones sincronizadas.</p>}
          </div>
        )}
        {tab === "details" && (
          <>
            <ResourceRelations
              draft={draft}
              resources={resources}
              members={members}
              editable={editable}
              setData={setData}
              open={open}
              create={create}
            />
            <Attachments
              workspaceId={workspaceId}
              resourceId={resource.id}
              userId={user.id}
              editable={editable}
              error={error}
            />
          </>
        )}
      </div>
      <footer className="modal-footer">
        <div>
          <ResourceLink id={resource.id} />
          {["project", "document"].includes(resource.kind) && (
            <button
              className="text-button"
              onClick={async () => {
                setBusy(true);
                try {
                  const { downloadDocuments } =
                    await import("./offline-documents");
                  const documents =
                    resource.kind === "document"
                      ? [resource]
                      : resources.filter(
                          (r: Resource) =>
                            r.kind === "document" &&
                            r.data.projectId === resource.id,
                        );
                  const count = await downloadDocuments(
                    user.id,
                    workspaceId,
                    documents,
                  );
                  notify(
                    `${count} documentos descargados para trabajar sin conexión.`,
                  );
                } catch (e) {
                  error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Descargar para sin conexión
            </button>
          )}
          {editable && (
            <button
              className="danger text-button"
              onClick={async () => {
                if (!confirm(`¿Mover «${resource.title}» a la papelera?`))
                  return;
                await save({
                  ...resource,
                  deleted_at: new Date().toISOString(),
                });
                close();
              }}
            >
              <Trash2 size={15} />
              Eliminar
            </button>
          )}
          {canEdit && reminderTargetKinds.has(resource.kind) && (
            <button
              className="text-button"
              onClick={() => requestReminder(resource)}
            >
              <Bell size={15} />
              Crear recordatorio personal
            </button>
          )}
          {resource.kind === "document" && (
            <select
              aria-label="Formato de exportación"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value)}
            >
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
              <option value="pdf">Imprimir / PDF</option>
              <option value="json">JSON</option>
            </select>
          )}
          <button
            className="text-button"
            onClick={() =>
              resource.kind === "document"
                ? exportDocument()
                : download(
                    `${draft.title}.json`,
                    JSON.stringify(draft, null, 2),
                    "application/json",
                  )
            }
          >
            <ArrowDownToLine size={15} />
            Exportar
          </button>
        </div>
        <div>
          <span className="muted">
            {dirty ? "Cambios sin guardar" : "Guardado"}
          </span>
          {editable && (
            <button
              className="primary"
              disabled={!dirty || busy || !draft.title.trim()}
              onClick={() => void persist()}
            >
              {busy ? "Guardando…" : "Guardar cambios"}
            </button>
          )}
        </div>
      </footer>
    </Modal>
  );
}

function SearchField({
  value,
  set,
  autoFocus = false,
}: {
  value: string;
  set: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="search-field">
      <Search size={15} />
      <input
        aria-label="Buscar"
        placeholder="Buscar…"
        value={value}
        onChange={(e) => set(e.target.value)}
        autoFocus={autoFocus}
      />
      {value && (
        <button aria-label="Vaciar búsqueda" onClick={() => set("")}>
          <X size={13} />
        </button>
      )}
    </label>
  );
}
function Empty({ icon: Icon, title, description, action, onAction }: any) {
  return (
    <div className="empty-state">
      <Icon size={34} strokeWidth={1.3} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action && (
        <button onClick={onAction}>
          <Plus size={16} />
          {action}
        </button>
      )}
    </div>
  );
}
function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Calendar({ tasks, open }: any) {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const start = new Date(month);
  start.setDate(1 - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return (
    <>
      <div className="calendar-heading">
        <h2>
          {month.toLocaleDateString("es", { month: "long", year: "numeric" })}
        </h2>
        <div>
          <button
            aria-label="Mes anterior"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            ←
          </button>
          <button
            onClick={() =>
              setMonth(
                new Date(new Date().getFullYear(), new Date().getMonth(), 1),
              )
            }
          >
            Hoy
          </button>
          <button
            aria-label="Mes siguiente"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            →
          </button>
        </div>
      </div>
      <div className="calendar-grid">
        {[
          "Lunes",
          "Martes",
          "Miércoles",
          "Jueves",
          "Viernes",
          "Sábado",
          "Domingo",
        ].map((d) => (
          <div className="calendar-weekday" key={d}>
            {d}
          </div>
        ))}
        {days.map((d) => (
          <div
            key={iso(d)}
            className={`calendar-day ${d.getMonth() !== month.getMonth() ? "other-month" : ""} ${iso(d) === iso(new Date()) ? "today" : ""}`}
          >
            <span>{d.getDate()}</span>
            {tasks
              .filter((t: Resource) => t.data.dueDate === iso(d))
              .map((t: Resource) => (
                <button onClick={() => open(t)} key={t.id}>
                  {t.title}
                </button>
              ))}
          </div>
        ))}
      </div>
      <h3 className="calendar-mobile-title">Tareas con fecha</h3>
      <div className="calendar-agenda">
        {tasks
          .filter((t: Resource) => t.data.dueDate)
          .sort((a: Resource, b: Resource) =>
            a.data.dueDate.localeCompare(b.data.dueDate),
          )
          .map((t: Resource) => (
            <button key={t.id} onClick={() => open(t)}>
              <span>{dateText(t.data.dueDate)}</span>
              {t.title}
            </button>
          ))}
      </div>
    </>
  );
}
function Team({ members, workspace, refresh, error }: any) {
  const [link, setLink] = useState("");
  return (
    <>
      <div className="member-list">
        {members.map((m: any) => (
          <div className="member-row" key={m.id}>
            <span className="avatar">{m.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{m.name}</strong>
              <small>{m.email}</small>
            </div>
            {workspace.role === "admin" ? (
              <select
                aria-label={`Rol de ${m.name}`}
                value={m.role}
                onChange={async (e) => {
                  try {
                    await api(
                      `/workspaces/${workspace.id}/members/${m.id}`,
                      send({ role: e.target.value }, "PATCH"),
                    );
                    await refresh();
                  } catch (e) {
                    error((e as Error).message);
                  }
                }}
              >
                <option value="admin">Administrador</option>
                <option value="member">Miembro</option>
                <option value="viewer">Solo lectura</option>
                <option value="guest">Invitado</option>
              </select>
            ) : (
              <span>{m.role}</span>
            )}
          </div>
        ))}
      </div>
      {workspace.role === "admin" && (
        <section className="settings-section">
          <div>
            <h2>Invita a tu equipo</h2>
            <p>
              Genera un enlace personal que caduca a los siete días. Compártelo
              con la persona invitada.
            </p>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(e.currentTarget));
              try {
                setLink(
                  (
                    await api(
                      `/workspaces/${workspace.id}/invitations`,
                      send(data),
                    )
                  ).url,
                );
              } catch (e) {
                error((e as Error).message);
              }
            }}
          >
            <Field label="Correo de la persona invitada">
              <input name="email" type="email" required />
            </Field>
            <Field label="Permisos">
              <select name="role">
                <option value="member">Miembro</option>
                <option value="viewer">Solo lectura</option>
                <option value="guest">
                  Invitado a proyectos seleccionados
                </option>
              </select>
            </Field>
            <button className="primary">Generar invitación</button>
            {link && (
              <Field label="Enlace de invitación">
                <input
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
            )}
          </form>
        </section>
      )}
    </>
  );
}
function Activity({ workspaceId, resources, open }: any) {
  const [activity, setActivity] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    api(`/workspaces/${workspaceId}/activity`)
      .then((r) => setActivity(r.activity))
      .catch((e) => setError(e.message));
  }, [workspaceId]);
  const labels: any = {
    created: "creó",
    updated: "actualizó",
    deleted: "eliminó",
    delivery_confirmed: "confirmó la entrega",
    sprint_closed: "cerró el sprint",
    sprint_rollover: "trasladó la tarea",
    sprint_planned: "actualizó la planificación",
    sprint_started: "inició el sprint",
    sprint_scope_changed: "cambió el alcance de la tarea",
    sprint_review_updated: "actualizó la revisión y retrospectiva",
    poker_started: "inició una ronda de estimación",
    poker_estimate_applied: "aplicó la estimación acordada",
    automation_updated: "actualizó mediante una regla",
    automation_notification: "creó una notificación automática",
    personal_reminder: "entregó un recordatorio personal",
    recurrence_created: "creó la siguiente tarea recurrente",
    automation_retry: "reintentó una ejecución",
    ai_generated: "generó una propuesta con IA",
  };
  return (
    <div className="activity-feed">
      {error && <p role="alert">{error}</p>}
      {activity.map((event) => (
        <article key={event.sequence}>
          <span className="avatar small">
            {event.user_name?.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <p>
              <strong>{event.user_name}</strong>{" "}
              {labels[event.action] || event.action}
              {event.resource_id && (
                <button
                  className="text-button"
                  onClick={() => {
                    const r = resources.find(
                      (r: Resource) => r.id === event.resource_id,
                    );
                    if (r) open(r);
                  }}
                >
                  {resources.find((r: Resource) => r.id === event.resource_id)
                    ?.title || "Elemento"}
                </button>
              )}
            </p>
            <time>{new Date(event.created_at).toLocaleString("es")}</time>
          </div>
        </article>
      ))}
      {!activity.length && !error && (
        <Empty
          icon={History}
          title="El historial empieza aquí"
          description="Los cambios del equipo quedarán registrados en este espacio."
        />
      )}
    </div>
  );
}
function SettingsView({
  user,
  workspace,
  preferences,
  updatePreference,
  notify,
  error,
  reload,
  preferencesSaved,
}: any) {
  const [area, setArea] = useState("general"),
    [ai, setAi] = useState<any>(null),
    [sessions, setSessions] = useState<any[]>([]);
  useEffect(() => {
    if (area === "ai" && workspace.role === "admin")
      api(`/workspaces/${workspace.id}/ai/settings`)
        .then(setAi)
        .catch((e) => error(e.message));
    if (area === "sessions")
      api("/sessions")
        .then((r) => setSessions(r.sessions))
        .catch((e) => error(e.message));
  }, [area, workspace.id]);
  return (
    <>
      <div className="view-tabs">
        {[
          ["general", "General"],
          ["appearance", "Apariencia"],
          ["notifications", "Notificaciones"],
          ["security", "Seguridad"],
          ["ai", "Inteligencia artificial"],
          ["data", "Datos"],
          ["sessions", "Sesiones"],
        ].map(([v, l]) => (
          <button
            className={area === v ? "active" : ""}
            key={v}
            onClick={() => setArea(v)}
          >
            {l}
          </button>
        ))}
      </div>
      {area === "security" && (
        <SecuritySettings notify={notify} error={error} />
      )}
      {area === "notifications" && (
        <Suspense fallback={<p role="status">Abriendo tus preferencias…</p>}>
          <NotificationSettings
            key={user.id}
            userId={user.id}
            preferences={preferences}
            saved={preferencesSaved}
          />
        </Suspense>
      )}
      {area === "general" && (
        <>
          <section className="settings-section">
            <div>
              <h2>Tu cuenta</h2>
              <p>Identidad y espacio de trabajo actual.</p>
            </div>
            <div className="settings-panel">
              <Field label="Nombre">
                <input readOnly value={user.name} />
              </Field>
              <Field label="Correo">
                <input readOnly value={user.email} />
              </Field>
              <Field label="Espacio">
                <input readOnly value={workspace.name} />
              </Field>
            </div>
          </section>
        </>
      )}
      {area === "appearance" && (
        <section className="settings-section">
          <div>
            <h2>Apariencia</h2>
            <p>Una interfaz cómoda durante toda la jornada.</p>
          </div>
          <div className="settings-panel">
            <Field label="Tema">
              <select
                value={preferences.theme || "system"}
                onChange={(e) =>
                  void updatePreference({ theme: e.target.value })
                }
              >
                <option value="system">Usar el del sistema</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </Field>
            <Field label="Zona horaria">
              <input
                defaultValue={
                  preferences.timeZone ||
                  Intl.DateTimeFormat().resolvedOptions().timeZone
                }
                onBlur={(e) =>
                  void updatePreference({ timeZone: e.target.value })
                }
              />
            </Field>
          </div>
        </section>
      )}
      {area === "ai" &&
        (workspace.role !== "admin" ? (
          <p>
            La configuración de IA corresponde a la administración del espacio.
          </p>
        ) : (
          ai && (
            <section className="settings-section">
              <div>
                <h2>IA opcional, por API</h2>
                <p>
                  La aplicación funciona sin IA. Cada solicitud enviará
                  únicamente el contexto que selecciones.
                </p>
                <p>
                  {ai.requestCount || 0} solicitudes en el periodo registrado.
                </p>
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  try {
                    await api(
                      `/workspaces/${workspace.id}/ai/settings`,
                      send(
                        {
                          enabled: f.get("enabled") === "on",
                          provider: f.get("provider"),
                          model: f.get("model"),
                          apiKey: f.get("apiKey") || undefined,
                          monthlyRequestLimit: Number(
                            f.get("monthlyRequestLimit"),
                          ),
                        },
                        "PUT",
                      ),
                    );
                    notify("Configuración de IA guardada.");
                  } catch (e) {
                    error((e as Error).message);
                  }
                }}
              >
                <label className="checklist-item">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={ai.enabled}
                  />
                  Habilitar IA para los miembros
                </label>
                <Field label="Proveedor">
                  <select
                    name="provider"
                    defaultValue={ai.provider || "openai-compatible"}
                  >
                    <option value="openai-compatible">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </Field>
                <Field label="Identificador del modelo">
                  <input
                    name="model"
                    required
                    defaultValue={ai.model || ""}
                    placeholder="Identificador del modelo de tu proveedor"
                  />
                </Field>
                <Field
                  label={
                    ai.hasApiKey ? "Nueva clave API (opcional)" : "Clave API"
                  }
                >
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="Límite mensual de solicitudes">
                  <input
                    type="number"
                    name="monthlyRequestLimit"
                    min="0"
                    max="100000"
                    defaultValue={ai.monthlyRequestLimit || 100}
                  />
                </Field>
                <button className="primary">Guardar configuración</button>
              </form>
            </section>
          )
        ))}
      {area === "data" && (
        <section className="settings-section">
          <div>
            <h2>Tus datos</h2>
            <p>
              Descarga los elementos a los que tienes acceso, incluido el estado
              colaborativo de los documentos.
            </p>
          </div>
          <div className="settings-panel">
            <button
              onClick={async () => {
                try {
                  const data = await api(`/workspaces/${workspace.id}/export`);
                  download(
                    "kelvin-workspace.json",
                    JSON.stringify(data, null, 2),
                    "application/json",
                  );
                } catch (e) {
                  error((e as Error).message);
                }
              }}
            >
              <ArrowDownToLine size={16} />
              Exportar espacio
            </button>
            <a
              className="export-archive"
              href={`/api/workspaces/${workspace.id}/export/archive`}
              download="kelvin-workspace.tar.gz"
            >
              <ArrowDownToLine size={16} />
              Exportar espacio completo con adjuntos
            </a>
            <button
              onClick={async () => {
                const estimate = await navigator.storage?.estimate();
                notify(
                  `Almacenamiento local: ${((estimate.usage || 0) / 1048576).toFixed(1)} MB`,
                );
              }}
            >
              Consultar almacenamiento local
            </button>
            <button
              onClick={async () => {
                const ok = await navigator.storage?.persist();
                notify(
                  ok
                    ? "Almacenamiento persistente concedido."
                    : "El navegador conserva el control sobre el almacenamiento.",
                );
              }}
            >
              Solicitar almacenamiento persistente
            </button>
          </div>
        </section>
      )}
      {area === "sessions" && (
        <section>
          <h2>Sesiones abiertas</h2>
          {sessions.map((s) => (
            <div className="document-row" key={s.id}>
              <div>
                <strong>{s.user_agent || "Dispositivo"}</strong>
                <p>Iniciada {new Date(s.created_at).toLocaleString("es")}</p>
              </div>
              <button
                onClick={async () => {
                  await api(`/sessions/${s.id}`, { method: "DELETE" });
                  setSessions(sessions.filter((v) => v.id !== s.id));
                  notify("Sesión revocada.");
                }}
              >
                Revocar
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
function AIView({ workspaceId, resources, error, create, open }: any) {
  const [selected, setSelected] = useState<string[]>([]),
    [prompt, setPrompt] = useState(""),
    [proposal, setProposal] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="ai-layout">
      <section>
        <h2>¿En qué avanzamos?</h2>
        <p className="muted">
          Elige el contexto y pide un resumen, un plan o una propuesta. Tú
          decides qué se guarda.
        </p>
        <div className="ai-suggestions">
          {[
            "Resume el estado del proyecto y sus bloqueos.",
            "Propón tareas con criterios de aceptación.",
            "Prepara un objetivo y un plan para el próximo sprint.",
          ].map((text) => (
            <button key={text} onClick={() => setPrompt(text)}>
              {text}
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setProposal(
                (
                  await api(
                    `/workspaces/${workspaceId}/ai/generate`,
                    send({ prompt, resourceIds: selected }),
                  )
                ).proposal,
              );
            } catch (e) {
              error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Tu solicitud">
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </Field>
          <p className="muted">
            Se enviarán tu solicitud y {selected.length} elementos al proveedor
            configurado.
          </p>
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Sparkles size={16} />
            )}
            Generar propuesta
          </button>
        </form>
        {proposal && (
          <section className="ai-proposal">
            <h2>Propuesta para revisar</h2>
            <pre>{proposal}</pre>
            <button
              onClick={async () => {
                const r = await create("document", "Propuesta del asistente", {
                  description: proposal,
                  content: {
                    type: "doc",
                    content: proposal.split("\n").map((line) => ({
                      type: "paragraph",
                      ...(line
                        ? { content: [{ type: "text", text: line }] }
                        : {}),
                    })),
                  },
                });
                if (r) open(r);
              }}
            >
              Guardar como documento
            </button>
          </section>
        )}
      </section>
      <aside className="ai-context">
        <h2>Contexto seleccionado</h2>
        <p className="muted">Solo se enviarán los elementos marcados.</p>
        {resources
          .filter((r: Resource) =>
            ["project", "document", "task", "sprint"].includes(r.kind),
          )
          .map((r: Resource) => (
            <label className="checklist-item" key={r.id}>
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, r.id]
                      : selected.filter((id) => id !== r.id),
                  )
                }
              />
              <span>
                <small>{kindLabels[r.kind]}</small>
                {r.title}
              </span>
            </label>
          ))}
      </aside>
    </div>
  );
}
