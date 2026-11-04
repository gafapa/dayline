import { authorizeLocalUser, withLocalSessionGate } from "./local-lifecycle";
import { DragProvider, useDrag, useDrop } from "./dnd";
import { useLocalGuard } from "./useLocalGuard";
import { coordinateLocalSession, signOutEverywhereLocal, LocalWorkRetained } from "./session-coordination";
import { DOCUMENT_SCHEMA_EVENT, DOCUMENT_SCHEMA_MESSAGE } from "../shared/document-protocol";
import { isStructure, structureParent } from "../shared/hierarchy";
import { applyFieldDefaults, fieldDefaults, fieldValueError } from "../shared/custom-fields";
import { resolveNavigation } from "./resolve-navigation";
import { navigationEvent, localResourceLocation } from "./navigation";
import { readAppRoute, pageHref, type AppPage } from "../shared/navigation";
import { Modal } from "./components/Primitives";
import { isDelivery } from "../shared/delivery";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, CalendarDays, Check, ChevronDown, ChevronRight, CircleCheck, FileText, Flag, FolderKanban, Inbox, LayoutDashboard, ListFilter, LoaderCircle, LogOut, Menu, MoreHorizontal, Plus, Search, Settings, Sparkles, Star, Target, Trash2, Users, WifiOff, X, History, Layers, Clock3, Sun } from "lucide-react";
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
    <DragProvider onError={(message) => setError(message)}>
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
                <Calendar tasks={tasks} open={openResource} save={save} canEdit={canEdit} />
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
