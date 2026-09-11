import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import Fuse from 'fuse.js';

import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Task, Project, TaskPriority, TaskStatus } from '@/types/task';
import { TaskCard } from '@/components/TaskCard';
import { TaskListItem } from '@/components/TaskListItem';
import { GanttChart } from '@/components/GanttChart';
import { TimeTrackingChart } from '@/components/TimeTrackingChart';
import { AddTaskDialog } from '@/components/AddTaskDialog';
import { ProjectSidebar } from '@/components/ProjectSidebar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { TouchDialog, TouchDialogContent, TouchSheet, TouchSheetContent } from '@/components/ui/touch-dialog';
import { Search, LayoutList, LayoutGrid, GanttChartSquare, Clock, LogOut, FolderKanban, ListChecks, Calendar, Settings, Eye, ChevronDown, Check, Trash2, Mic, ArrowUpDown, Share2, Plus, AlertTriangle, UserPlus, Pencil, X, Archive, ArchiveRestore, Folder, FolderPlus, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from 'sonner';
import HeroSection from '@/components/HeroSection';
import { startOfDay, endOfDay } from 'date-fns';
import { SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import { useProjectBarFold } from '@/hooks/useProjectBarFold';

import BottomNav from '@/components/BottomNav';
import { BrainDumpLiveDialog } from '@/components/BrainDumpLiveDialog';
import SettingsDialog from '@/components/SettingsDialog';
import { useUserPreferences, type UserPreferences } from '@/hooks/useUserPreferences';
// OnboardingTour removed — replaced by HomeTour on /home
import { TaskTour } from '@/components/TaskTour';
import { ProjectTour } from '@/components/ProjectTour';
import { EditTaskDialog } from '@/components/EditTaskDialog';
import { DraggableTaskList } from '@/components/DraggableTaskList';
import { ShareItemDialog } from '@/components/ShareItemDialog';
import { ShareStatusPopover } from '@/components/ShareStatusPopover';
import { InviteProjectMemberDialog } from '@/components/InviteProjectMemberDialog';
import { ProjectMembersBar } from '@/components/ProjectMembersBar';
import { addDays } from 'date-fns';
import RecordFAB from '@/components/RecordFAB';
import {
  fetchAllTasks as fetchAllTasksShared,
  fetchCompletedTasks as fetchCompletedTasksShared,
  fetchProjects as fetchProjectsShared,
  fetchMemberProjectIds as fetchMemberIdsShared,
  fetchTaskImages as fetchTaskImagesShared,
  fetchSenderSharedItemsShared,
  appDataKeys,
  slimTaskRow,
  isProjectArchived,
  isSubProject,
  type RawProjectRow,
} from '@/lib/appDataFetchers';
import {
  subProjectIdsOf,
  projectMoveRefusal,
  sortProjectsForDisplay,
  countPinned,
  PIN_LIMIT,
  PIN_LIMIT_MESSAGE,
} from '@/lib/projectTree';
import { buildSenderSharedMaps, type RawSharedItemRow } from '@/lib/sharedItems';
import { TaskListSkeleton, AppBootSkeleton, LoadErrorPanel } from '@/components/AppSkeletons';

// Special-list identity (icon + label + colour + whether Share applies). ONE
// source of truth, shared by the desktop special banner and the mobile one-bar
// so the two can never drift apart.
const SPECIAL_LIST_CFG = {
  'today': { Icon: Calendar, label: 'Today', color: 'text-primary', share: true },
  'past-due': { Icon: AlertTriangle, label: 'Past Due', color: 'text-orange-500', share: false },
  'unassigned': { Icon: ListChecks, label: 'Unassigned Tasks', color: 'text-muted-foreground', share: true },
} as const;

// Status filter labels — verbatim the lg-tabs trigger labels, so the mobile
// pill and the desktop tabs always read the same words.
const STATUS_LABELS = {
  'all': 'All',
  'todo': 'To Do',
  'in-progress': 'Progress',
  'completed': 'Done',
} as const;

const STATUS_ORDER = ['all', 'todo', 'in-progress', 'completed'] as const;

// Last successful non-empty open-task count per account — the "this account is not
// actually empty" hint behind the vanish defence.
const lastKnownOpenCount = (uid: string): number => {
  try {
    return Number(localStorage.getItem(`focusos-open-count-${uid}`) || '0');
  } catch {
    return 0;
  }
};

// BottomNav wrapper that provides sidebar toggle - must be inside SidebarProvider
type BottomNavWithSidebarProps = {
  projects: { id: string; name: string; color?: string }[];
  preferences: UserPreferences | null;
  prefsLoading: boolean;
  onSavePreferences: (updates: Partial<UserPreferences>) => Promise<void>;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
};

const BottomNavWithSidebar = ({
  projects,
  preferences,
  prefsLoading,
  onSavePreferences,
  settingsOpen,
  onSettingsOpenChange,
}: BottomNavWithSidebarProps) => {
  const { toggleSidebar } = useSidebar();

  return (
    <BottomNav
      projects={projects}
      onToggleSidebar={toggleSidebar}
      preferences={preferences}
      prefsLoading={prefsLoading}
      onSavePreferences={onSavePreferences}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={onSettingsOpenChange}
    />
  );
};

// Mobile sidebar controller - handles both Projects Tour AND openSidebar navigation
const MobileSidebarController = ({ tourStep, isTourActive, currentTourStep, openSidebarRequested, onOpenSidebarHandled }: { tourStep: number | null; isTourActive: boolean; currentTourStep: number; openSidebarRequested: boolean; onOpenSidebarHandled: () => void }) => {
  const { setOpenMobile, isMobile } = useSidebar();
  
  // Handle openSidebar request from navigation (e.g. Home -> Projects)
  React.useEffect(() => {
    if (!openSidebarRequested || !isMobile) return;
    setOpenMobile(true);
    onOpenSidebarHandled();
  }, [openSidebarRequested, isMobile, setOpenMobile, onOpenSidebarHandled]);

  // Handle tour steps
  React.useEffect(() => {
    if (!isTourActive || !isMobile) return;
    
    const activeStep = currentTourStep;
    
    if (activeStep === 0 || activeStep === 2) {
      setOpenMobile(true);
    } else {
      const timer = setTimeout(() => {
        setOpenMobile(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [currentTourStep, isTourActive, isMobile, setOpenMobile]);
  
  return null;
};

const Index = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    user,
    loading: authLoading,
    signOut
  } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  // Full own+shared project rows, archived included — the ONE consumer that must
  // keep seeing archived projects (report note #4: their timer totals stay
  // findable by name/color in TimeTrackingChart's per-project grouping instead of
  // collapsing into "Unassigned"). Every other reader of project data uses the
  // active-only `projects` state above.
  const [allProjectsForReports, setAllProjectsForReports] = useState<Project[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Redirect to auth if not logged in
  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [authLoading, user, navigate]);

  // Debounce search input → searchQuery (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'gantt' | 'time-tracking'>('grid');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSpecialList, setSelectedSpecialList] = useState<'unassigned' | 'today' | 'past-due' | null>(null);
  const [projectRefreshTrigger, setProjectRefreshTrigger] = useState(0);
  // O7 (2026-08-26): bumped after a share/assign event so the drawer's own
  // Shared Items section (ProjectSidebar's sharedItems state) refetches live,
  // same shape as projectRefreshTrigger, a plain counter the drawer's own
  // effect keys off, not a second fetch mechanism.
  const [sharedItemsRefreshTrigger, setSharedItemsRefreshTrigger] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isBrainDumpRecording, setIsBrainDumpRecording] = useState(false);
  const [isBrainDumpCtaActive, setIsBrainDumpCtaActive] = useState(false);
  const [globalCardView, setGlobalCardView] = useState<'full' | 'compact' | 'minimal'>('full');
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'all' | 'todo' | 'in-progress' | 'completed'>('all');
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  // Both latches are STATE on purpose: these blocks run during render, and React may
  // discard+replay a transition render (react-router navigations). A ref mutation
  // survives the discard while the queued state updates do not — the replay would
  // skip the block and drop the apply entirely (caught 2026-07-25: stuck selection).
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null);
  const [warmStartDone, setWarmStartDone] = useState(false);
  const [openSidebarRequested, setOpenSidebarRequested] = useState(false);
  // One-shot latch for the ?openSidebar handshake. The effect that consumes the
  // param re-runs on every `projects` change (the two-wave projects apply)
  // while the URL-strip navigate(replace) is still in flight — async, so
  // location.search still carries openSidebar=true on those interim re-runs.
  // Without this latch each re-run re-raises setOpenSidebarRequested(true) and
  // can reopen the drawer. Latched on consume, cleared once the param leaves the
  // URL, so a fresh navigation with ?openSidebar=true is still handled once.
  const openSidebarHandledRef = useRef(false);
  // Same one-shot shape for the ?tour= handshake (see the effect below).
  const tourParamHandledRef = useRef(false);
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [editedProjectName, setEditedProjectName] = useState('');
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [showTaskTour, setShowTaskTour] = useState(false);
  const [taskTourTask, setTaskTourTask] = useState<Task | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  // Mobile edit pane closes in two steps: open=false plays the slide-down
  // exit animation, THEN the component unmounts. Unmounting immediately
  // (editingTask=null) would skip the animation entirely.
  const [editClosing, setEditClosing] = useState(false);
  const closeEditPane = () => {
    if (isMobile) {
      setEditClosing(true);
      setTimeout(() => {
        setEditingTask(null);
        setEditClosing(false);
      }, 340);
    } else {
      setEditingTask(null);
    }
  };
  const [editHighlight, setEditHighlight] = useState<{ target: 'images' | 'dates'; nonce: number } | null>(null);
  useEffect(() => { if (!editingTask) setEditHighlight(null); }, [editingTask]);
  const handleEditTaskImages = (task: Task) => {
    setEditHighlight(prev => ({ target: 'images', nonce: (prev?.nonce ?? 0) + 1 }));
    setEditingTask(task);
  };
  const handleEditTaskDates = (task: Task) => {
    setEditHighlight(prev => ({ target: 'dates', nonce: (prev?.nonce ?? 0) + 1 }));
    setEditingTask(task);
  };
  const [taskToShare, setTaskToShare] = useState<Task | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareProjectDialogOpen, setShareProjectDialogOpen] = useState(false);
  const [changesNeededTask, setChangesNeededTask] = useState<Task | null>(null);
  const [changesNeededMessage, setChangesNeededMessage] = useState('');
  const [changesNeededDialogOpen, setChangesNeededDialogOpen] = useState(false);
  const [changesNeededLoading, setChangesNeededLoading] = useState(false);
  const [addTaskDialogOpen, setAddTaskDialogOpen] = useState(false);

  // ---- Mobile one-bar (<lg) chrome. TRIGGER state only: which sheet is open and
  // whether the bar has swapped into search mode. viewMode / globalCardView /
  // activeTab / searchInput keep their own state, defaults and persistence paths
  // untouched — the bar only moves where they are set from. ----
  const [onebarSheet, setOnebarSheet] = useState<null | 'context' | 'status' | 'move'>(null);
  const [onebarSearchOpen, setOnebarSearchOpen] = useState(false);
  const onebarSearchRef = useRef<HTMLInputElement | null>(null);
  // WKWebView drops programmatic focus that happens outside the user-gesture call
  // stack, so the mode swap is flushed synchronously inside the tap handler and the
  // input is focused before the handler returns — never from a post-paint effect.
  const openOnebarSearch = () => {
    flushSync(() => setOnebarSearchOpen(true));
    onebarSearchRef.current?.focus();
  };
  // Cancel restores the bar and drops focus. It deliberately does NOT clear
  // searchInput: the desktop lg-search has no clear affordance either, so clearing
  // here would be a behaviour change. The collapsed icon carries a dot instead, so
  // a live filter is never invisible.
  const closeOnebarSearch = () => {
    onebarSearchRef.current?.blur();
    setOnebarSearchOpen(false);
  };

  const [fabExpanded, setFabExpanded] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  // "New sub-project" (onebar): opens the DRAWER's own Create Project dialog with
  // a parent preselected, rather than standing up a second create surface. While
  // this is set, Index controls that dialog's open state (see the ProjectSidebar
  // props below); when it clears, the drawer goes back to owning it.
  const [newSubParentId, setNewSubParentId] = useState<string | null>(null);
  const [memberRefreshTrigger, setMemberRefreshTrigger] = useState(0);
  const [fullDataLoaded, setFullDataLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const allTasksRef = useRef<Task[]>([]);
  useEffect(() => { allTasksRef.current = allTasks; }, [allTasks]);
  // Accepted-membership project ids (shared projects the current user can see).
  // Held in a ref so the zero-arg fetch functions read the latest set without threading.
  const memberProjectIdsRef = useRef<string[]>([]);
  const [senderSharedMap, setSenderSharedMap] = useState<Record<string, Array<{ email: string; name: string; status: string; sharedItemId?: string }>>>({});
  const [senderProjectSharedMap, setSenderProjectSharedMap] = useState<Record<string, Array<{ email: string; name: string; status: string; sharedItemId?: string }>>>({});
  const [assignerNameMap, setAssignerNameMap] = useState<Record<string, string>>({});
  const [showProjectsTour, setShowProjectsTour] = useState(false);
  const [projectsTourCurrentStep, setProjectsTourCurrentStep] = useState(0);
  const [projectsTourProjects, setProjectsTourProjects] = useState<{id: string, name: string}[]>([]);
  const [projectsTourTask, setProjectsTourTask] = useState<Task | null>(null);
  const [createProjectDialogOpenForTour, setCreateProjectDialogOpenForTour] = useState(false);
  const [tourCreateDialogOpen, setTourCreateDialogOpen] = useState(false);
  const [lastProcessedTourStep, setLastProcessedTourStep] = useState<number | null>(null);
  
  const { preferences, loading: prefsLoading, updatePreferences, markOnboardingComplete, markTaskTourComplete, markProjectsTourComplete } = useUserPreferences(user?.id);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // O7 cross-page fix (skeptic residual, 2026-08-26): the trigger bump only
  // reaches THIS page's drawer instance; another page's drawer mounts later
  // with its own trigger at 0 and a non-fresh mount fetch that would serve
  // the 5-minute-stale sharedItems cache (share here, then visit /home
  // within 5 minutes: stale drawer there). Invalidating the shared key at
  // share time makes every later non-fresh fetch, on any page, go to
  // network, while this page's own drawer still updates through the trigger.
  const noteShareEvent = useCallback(() => {
    if (user?.id) void queryClient.invalidateQueries({ queryKey: appDataKeys.sharedItems(user.id) });
    setSharedItemsRefreshTrigger(prev => prev + 1);
  }, [user?.id, queryClient]);
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  // Sync sidebar state with screen size changes
  useEffect(() => {
    setSidebarOpen(!isMobile);
  }, [isMobile]);

  // Handle clicking outside task cards to collapse them
  useEffect(() => {
    const handleClickOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;

      // An open dropdown swallows this click to dismiss itself (Radix disables
      // page pointer-events, so the target reports as <body>) — never collapse
      // cards on the same click.
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;

      // Check if click is outside all task cards
      const isOutsideTaskCard = !target.closest('[data-task-card]');
      
      // Check if click is on the 3rd row elements (priority, date, photo)
      const isThirdRowClick = target.closest('[data-third-row]');
      
      // Check if click is on a dropdown menu (to keep task expanded when selecting priority)
      const isDropdownClick = target.closest('[role="menu"]') || 
                             target.closest('[role="menuitem"]') || 
                             target.closest('[data-radix-popper-content-wrapper]') ||
                             target.closest('[data-radix-dropdown-menu-content]') ||
                             target.closest('[role="dialog"]') ||
                             target.closest('[role="alertdialog"]') ||
                             target.closest('[data-side-panel]');
      
      const isAnyDialogOpen = !!document.querySelector('[role="dialog"], [role="alertdialog"], [data-side-panel]');
      
      if (isOutsideTaskCard && !isThirdRowClick && !isDropdownClick && !isAnyDialogOpen && expandedTaskIds.size > 0) {
        setExpandedTaskIds(new Set());
      }
    };

    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [expandedTaskIds]);

  // Auth redirect is now handled in the render gate below

  // Helper function to transform DB task format to app Task format
  const transformDbTask = useCallback((dbTask: any): Task => ({
    id: dbTask.id,
    title: dbTask.title,
    description: dbTask.description,
    priority: dbTask.priority,
    status: dbTask.status,
    startDate: dbTask.start_date ? new Date(dbTask.start_date) : undefined,
    endDate: dbTask.end_date ? new Date(dbTask.end_date) : undefined,
    dueDate: dbTask.due_date ? new Date(dbTask.due_date) : undefined,
    images: dbTask.images ? (dbTask.images as string[]) : [],
    timer: {
      totalSeconds: dbTask.timer_total_seconds,
      isRunning: dbTask.timer_is_running,
      startTime: dbTask.timer_start_time
    },
    projectId: dbTask.project_id,
    sortOrder: dbTask.sort_order ?? 0,
    completedByEmail: dbTask.completed_by_email ?? undefined,
    assignedToEmail: dbTask.assigned_to_email ?? undefined,
    changeRequestMessage: dbTask.change_request_message ?? undefined,
    googleCalendarEventId: dbTask.google_calendar_event_id ?? undefined,
  }), []);

  // --- App-load fetches: explicit own/shared filters. RLS stays the security net;
  // these filters exist purely to give Postgres an indexable predicate (user_id /
  // project_id) instead of scanning every user's rows. "Shared" = projects where the
  // current user is an accepted member; those ids gate the shared task/project queries
  // and mirror the two RLS SELECT policies (own OR accepted-member) exactly. ---

  // The own/shared/merge/member-id read logic now lives once in src/lib/appDataFetchers
  // (fetchAllTasksShared / fetchCompletedTasksShared / fetchProjectsShared /
  // fetchMemberIdsShared / fetchTaskImagesShared), single-flighted under the shared query
  // keys so Index, ProjectSidebar and the /home prefetch collapse to one request each and
  // a cross-route remount within staleTime re-reads cache instead of the network.

  const applyProjectRows = useCallback((rows: any[]) => {
    const toProject = (p: RawProjectRow): Project => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isShared: p.is_shared ?? false,
      userId: p.user_id,
      archivedAt: p.archived_at ?? null,
      parentProjectId: isSubProject(p) ? p.parent_project_id : null,
      // O8: the manual position inside this row's sibling group, and its pin
      // state. Every list derives its order from these during render (see
      // sortProjectsForDisplay), so no surface reorders anything after paint.
      sortOrder: p.sort_order ?? null,
      pinnedAt: p.pinned_at ?? null,
      timer: {
        totalSeconds: 0,
        isRunning: false
      }
    });
    // Active-only: the state every selector, list, Gantt and the drawer's own
    // fetch read. Archived projects are excluded HERE, the single choke point —
    // see isProjectArchived in appDataFetchers.
    setProjects(rows.filter((p: RawProjectRow) => !isProjectArchived(p)).map(toProject));
    // Archived included: TimeTrackingChart alone reads this, so its per-project
    // name/color lookup never drops an archived project's total into "Unassigned".
    setAllProjectsForReports(rows.map(toProject));
  }, []);

  // The shared task fetchers now return the NON-completed (open) set only; completed rows
  // arrive separately (hydrateCompletedTasks) and share this same state. A fresh open-only
  // apply therefore PRESERVES any completed tasks already merged in — replacing the whole
  // list would blank the Done tab on every resync/refetch.
  const applyTaskRows = useCallback((rows: any[]) => {
    // TP1: the task-list projection (TASK_LIST_COLUMNS) omits `images`, so a slim row
    // must never be read as "images removed" — that display bug becomes data loss on
    // the next save. Decide on the RAW row, before transformDbTask turns a missing key
    // into []: key ABSENT keeps whatever images state (or this session's hydrated map)
    // already holds for that id; key PRESENT wins as-is, [] included, because a full
    // row carrying an empty array really has lost its images.
    const existingImagesById = new Map(allTasksRef.current.map(t => [t.id, t.images] as const));
    const openTasks = rows.map((raw) => {
      const task = transformDbTask(raw);
      if (raw && Object.prototype.hasOwnProperty.call(raw, 'images')) return task;
      const inState = existingImagesById.get(task.id);
      const kept = (inState && inState.length > 0) ? inState : hydratedImagesRef.current?.get(task.id);
      return kept && kept.length > 0 ? { ...task, images: kept } : task;
    });
    // A transient auth/RLS race can return 0 open rows; don't blank a list that already
    // holds open tasks. (0 open is legitimate for an all-completed account, whose state
    // holds only completed rows — that case is allowed through.)
    const hadOpen = allTasksRef.current.some(t => t.status !== 'completed');
    if (openTasks.length === 0 && hadOpen) {
      console.warn('[Index] open-task fetch returned 0 rows while open tasks exist — ignoring to avoid blanking the list (transient auth/RLS race)');
      return;
    }
    const openIds = new Set(openTasks.map(t => t.id));
    const keptCompleted = allTasksRef.current.filter(
      t => t.status === 'completed' && !openIds.has(t.id),
    );
    if (openTasks.length > 0) {
      setLoadFailed(false);
      if (user) {
        try { localStorage.setItem(`focusos-open-count-${user.id}`, String(openTasks.length)); } catch { /* no-op */ }
      }
    }
    setAllTasks([...openTasks, ...keptCompleted]);
  }, [transformDbTask, user]);

  // Event-driven projects refetch (post-mutation / tour). `fresh: true` bypasses the
  // 5-min stale cache so a just-created/renamed/deleted project is reflected; the
  // fetcher still refreshes memberships first (fresh) and dedupes concurrent callers.
  const fetchProjects = useCallback(async () => {
    if (!user) return;
    try {
      memberProjectIdsRef.current = await fetchMemberIdsShared(queryClient, user.id, { fresh: true });
      const rows = await fetchProjectsShared(queryClient, user.id, { fresh: true });
      applyProjectRows(rows);
    } catch (error) {
      console.error('[Index] fetchProjects failed:', error);
      toast.error('Failed to load projects');
    }
  }, [user, queryClient, applyProjectRows]);

  // Event-driven full task refetch (resync / post-mutation / tour). Fresh, single-flight.
  const fetchAllTasks = useCallback(async () => {
    if (!user) return;
    try {
      memberProjectIdsRef.current = await fetchMemberIdsShared(queryClient, user.id, { fresh: true });
      const rows = await fetchAllTasksShared(queryClient, user.id, { fresh: true });
      applyTaskRows(rows);
    } catch (error) {
      console.error('Error fetching all tasks:', error);
    }
  }, [user, queryClient, applyTaskRows]);

  // Build shared item maps from raw data (used by both cache and fetch paths)
  const buildSharedMaps = useCallback(async (sharedItems: any[]) => {
    if (!sharedItems || sharedItems.length === 0) {
      setSenderSharedMap({});
      setSenderProjectSharedMap({});
      return;
    }

    const recipientUserIds = sharedItems
      .map((si: any) => si.recipient_user_id)
      .filter((id: string | null) => id != null);

    let profilesMap: Record<string, string> = {};
    if (recipientUserIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('focusos_profiles')
        .select('user_id, first_name, last_name')
        .in('user_id', recipientUserIds);
      if (profiles) {
        for (const p of profiles) {
          const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
          if (name) profilesMap[p.user_id] = name;
        }
      }
    }

    // Pure grouping loop lives in src/lib/sharedItems.ts (O3, 2026-08-23) so
    // Home's own useQuery can build the same maps without a second copy.
    const { taskMap, projectMap } = buildSenderSharedMaps(sharedItems as RawSharedItemRow[], profilesMap);
    setSenderSharedMap(taskMap);
    setSenderProjectSharedMap(projectMap);
  }, []);

  // Fetch shared items where current user is sender. Routed through the shared
  // single-flight cache under appDataKeys.senderSharedItems (O3 fix-round,
  // 2026-08-23). `{fresh: true}` forces a live refetch (this is the
  // event-driven path: realtime + post-share callbacks), and writing into the
  // SHARED cache entry is what makes a share here visible to Home's own
  // useQuery on the same key without Home needing its own invalidate.
  const fetchSenderSharedItems = useCallback(async () => {
    if (!user) return;
    try {
      const sharedItems = await fetchSenderSharedItemsShared(queryClient, user.id, { fresh: true });
      await buildSharedMaps(sharedItems);
    } catch (err) {
      console.error('Error fetching sender shared items:', err);
    }
  }, [user, queryClient, buildSharedMaps]);


  // Legacy fetchTasks for specific use cases (task creation, etc.)
  // Always load the full task set so newly-created tasks for any list/project
  // land in `allTasks`; then re-apply the active view filter.
  const fetchTasks = useCallback(async () => {
    await fetchAllTasks();
  }, [fetchAllTasks]);

  // Re-fetch projects whenever projectRefreshTrigger changes (after initial load)
  useEffect(() => {
    if (initialLoadComplete) {
      fetchProjects();
    }
  }, [projectRefreshTrigger, initialLoadComplete, fetchProjects]);

  // Initial load — routed through the shared single-flight fetchers. Once user +
  // preferences are available, tasks and projects load in PARALLEL under the shared
  // keys; the task list unblocks the instant the tasks query resolves, never gated on
  // projects. An in-flight /home prefetch under the same key is REUSED (single flight),
  // not raced, and a warm getQueryData hit short-circuits to an instant no-network paint.
  useEffect(() => {
    const loadInitialData = async () => {
      if (!(user && preferences && !initialLoadComplete)) return;
      try {
        const cachedTasks = queryClient.getQueryData(appDataKeys.tasks(user.id)) as any[] | undefined;
        const cachedProjects = queryClient.getQueryData(appDataKeys.projects(user.id)) as any[] | undefined;

        if (cachedTasks && cachedTasks.length > 0 && cachedProjects) {
          // Warm cache hit — use prefetched data instantly (no network).
          applyTaskRows(cachedTasks);
          setFullDataLoaded(true);
          applyProjectRows(cachedProjects);

          // Also seed shared items from cache
          const cachedShared = queryClient.getQueryData(appDataKeys.senderSharedItems(user.id)) as any[] | undefined;
          if (cachedShared) {
            buildSharedMaps(cachedShared);
          }

          // Warm the member-id ref so image hydration + later refetches include shared rows
          // (single-flight — reuses the request the prefetch already made).
          fetchMemberIdsShared(queryClient, user.id)
            .then((ids) => { memberProjectIdsRef.current = ids; })
            .catch(() => {});
        } else {
          // Cold (or prefetch-in-flight) load. fetchQuery under the shared keys reuses an
          // in-flight prefetch rather than firing a duplicate request.
          const tasksP = fetchAllTasksShared(queryClient, user.id)
            .then((rows) => {
              if (rows.length === 0 && lastKnownOpenCount(user.id) > 0) {
                // The 07-24 vanish defence: this account is known to hold open tasks, so
                // an empty read is a failure, not truth. Evict the poisoned cache entry
                // (it was stored as a FRESH success) so Retry genuinely refetches.
                queryClient.removeQueries({ queryKey: appDataKeys.tasks(user.id) });
                setLoadFailed(true);
                return;
              }
              applyTaskRows(rows);
              setFullDataLoaded(true);
            })
            .catch((err) => {
              console.error('[Index] tasks load failed:', err);
              setLoadFailed(true);
            });

          const projectsP = fetchProjectsShared(queryClient, user.id)
            .then((rows) => { applyProjectRows(rows); })
            .catch(() => { toast.error('Failed to load projects'); });

          // Warm the member-id ref (single-flight — reuses the request the task/project
          // fetchers already triggered) for image hydration and later refetches.
          fetchMemberIdsShared(queryClient, user.id)
            .then((ids) => { memberProjectIdsRef.current = ids; })
            .catch(() => {});

          // Sender shared-item decorations are non-critical — load alongside, never gate.
          fetchSenderSharedItems();

          await Promise.all([tasksP, projectsP]);
        }
      } catch (err) {
        console.error('[Index] Initial data load failed:', err);
      } finally {
        setInitialLoadComplete(true);
      }
    };
    loadInitialData();
  }, [user, preferences, initialLoadComplete, queryClient, applyTaskRows, applyProjectRows, buildSharedMaps, fetchSenderSharedItems]);

  // ---- Deferred hydration of the two halves the critical-path load omits: completed
  // tasks and inline images. Both run once after first paint (fullDataLoaded) and both
  // single-flight through the shared cache, so a cross-route remount within staleTime
  // re-applies from cache instead of re-hitting the network. ----

  // Images already fetched this session (id -> images), covering open AND completed rows.
  // Lets a completed merge that lands before or after the image pass still pick up images.
  const hydratedImagesRef = useRef<Map<string, string[]> | null>(null);

  // Merge the completed set into allTasks. Existing state wins on id (keeps optimistic
  // edits and already-hydrated images on open tasks); freshly merged completed rows pick
  // up any images the image pass already fetched. Single-flight + 5-min cache via the
  // shared key, so a remount does not re-hit the network within staleTime.
  const hydrateCompletedTasks = useCallback(async (opts?: { fresh?: boolean }) => {
    if (!user) return;
    try {
      const rows = await fetchCompletedTasksShared(queryClient, user.id, { fresh: opts?.fresh });
      if (!rows.length) return;
      setAllTasks(prev => {
        const byId = new Map(prev.map(t => [t.id, t] as const));
        for (const raw of rows) {
          if (byId.has(raw.id)) continue; // existing state wins
          const t = transformDbTask(raw);
          const imgs = hydratedImagesRef.current?.get(t.id);
          byId.set(t.id, imgs && imgs.length > 0 ? { ...t, images: imgs } : t);
        }
        return Array.from(byId.values());
      });
    } catch (err) {
      console.warn('[Index] completed-task hydration failed:', err);
    }
  }, [user, queryClient, transformDbTask]);

  // Fetch completed tasks lazily, just after first paint. The Done count pill and Done tab
  // are always present in list/grid, so the default view effectively shows a completed
  // section — hence deferred-after-paint (like image hydration) rather than blocking login.
  const completedHydratedRef = useRef(false);
  useEffect(() => {
    if (!user || !fullDataLoaded || completedHydratedRef.current) return;
    const run = () => {
      if (completedHydratedRef.current) return;
      completedHydratedRef.current = true;
      hydrateCompletedTasks();
    };
    const handle = window.setTimeout(run, 800);
    return () => window.clearTimeout(handle);
  }, [user, fullDataLoaded, hydrateCompletedTasks]);

  // Deferred image hydration. The task-list load path (own/shared fetches + warm prefetch
  // cache) deliberately omits the heavy `images` column so the list paints fast; this
  // backfills images ~1s after the list is up, off the critical path. Routed through the
  // shared cache key (fetchTaskImagesShared) so an /app remount within staleTime re-applies
  // from cache instead of re-pulling the images. Runs once per mount, patches only tasks
  // whose images array is still empty (never clobbers an edit that landed in between).
  const imagesHydratedRef = useRef(false);
  // True once hydration has APPLIED (or proven there is nothing to hydrate). Gates
  // whether an empty images array on a task update means "removed" or "not loaded
  // yet" — before this flips, writing [] would wipe a task's stored images.
  const imagesReadyRef = useRef(false);
  useEffect(() => {
    if (!user || !fullDataLoaded || imagesHydratedRef.current) return;

    const run = async () => {
      // Guard the actual work (not just the scheduling) so a double-invoked effect
      // (React strict mode) hydrates exactly once.
      if (imagesHydratedRef.current) return;
      imagesHydratedRef.current = true;
      try {
        const imagesById = await fetchTaskImagesShared(queryClient, user.id);
        hydratedImagesRef.current = imagesById;
        if (imagesById.size === 0) { imagesReadyRef.current = true; return; }
        // Fill images only where the current task has none, so a task the user edited
        // between the slim load and now is never overwritten.
        setAllTasks(prev => prev.map(t =>
          (t.images && t.images.length > 0) || !imagesById.has(t.id)
            ? t
            : { ...t, images: imagesById.get(t.id)! }
        ));
        imagesReadyRef.current = true;
      } catch (err) {
        console.warn('[Index] image hydration failed:', err);
      }
    };

    const handle = window.setTimeout(run, 1000);
    return () => window.clearTimeout(handle);
  }, [user, fullDataLoaded, queryClient]);

  // Resolve assigner emails to names for shared project headers
  useEffect(() => {
    if (!allTasks.length || !projects.length) return;
    const sharedProjectIds = new Set(projects.filter(p => p.isShared).map(p => p.id));
    const assignerEmails = new Set<string>();
    for (const t of allTasks) {
      if (t.projectId && sharedProjectIds.has(t.projectId) && t.assignedToEmail) {
        assignerEmails.add(t.assignedToEmail);
      }
    }
    // Remove emails we already resolved
    const newEmails = [...assignerEmails].filter(e => !assignerNameMap[e]);
    if (newEmails.length === 0) return;
    (async () => {
      const { data: profiles } = await (supabase as any)
        .from('focusos_profiles')
        .select('user_email, first_name, last_name')
        .in('user_email', newEmails);
      if (profiles && profiles.length > 0) {
        const map: Record<string, string> = { ...assignerNameMap };
        for (const p of profiles) {
          const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
          if (name && p.user_email) map[p.user_email] = name;
        }
        setAssignerNameMap(map);
      }
    })();
  }, [allTasks, projects]);

  // Change request notifications are now handled via sidebar shared items, not toasts

  // Debounced resync safety net — refetches all tasks then re-applies the active filter.
  // Used to recover from missed realtime events after disconnects (tab backgrounded, network drop, etc.)
  const resyncDebounceRef = useRef<number | null>(null);
  const hasSubscribedOnceRef = useRef<boolean>(false);
  const resyncTasks = useCallback(() => {
    if (!user) return;
    if (!fullDataLoaded) return;
    if (resyncDebounceRef.current !== null) {
      window.clearTimeout(resyncDebounceRef.current);
    }
    resyncDebounceRef.current = window.setTimeout(async () => {
      resyncDebounceRef.current = null;
      await fetchAllTasks();
    }, 1000);
  }, [user, fullDataLoaded, fetchAllTasks]);
  const resyncTasksRef = useRef(resyncTasks);
  useEffect(() => { resyncTasksRef.current = resyncTasks; }, [resyncTasks]);

  // Wire up DOM events that signal a possible missed-event window
  useEffect(() => {
    if (!user) return;

    const onFocus = () => resyncTasks();
    const onOnline = () => resyncTasks();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resyncTasks();
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      if (resyncDebounceRef.current !== null) {
        window.clearTimeout(resyncDebounceRef.current);
        resyncDebounceRef.current = null;
      }
    };
  }, [user, resyncTasks]);

  // Resume refetch: after the tab has been hidden a while, in-memory data may have drifted
  // (missed realtime events, an expired-then-refreshed token). On return to visible after
  // >60s hidden, invalidate the shared queries and refetch tasks/projects/member-ids/
  // preferences once. Single-flight under the shared keys collapses this with any
  // concurrent trigger (e.g. the resync above), so it never storms.
  const hiddenSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!user) return;
    const uid = user.id;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = Date.now();
        return;
      }
      const hiddenFor = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0;
      hiddenSinceRef.current = null;
      if (hiddenFor < 60_000) return;

      // Preferences has an active observer (useUserPreferences) — invalidate refetches it.
      queryClient.invalidateQueries({ queryKey: appDataKeys.preferences(uid) });
      // Tasks / projects / member-ids are fetched imperatively — force a fresh
      // single-flight refetch and re-apply to local state (applyTaskRows keeps its
      // don't-blank-a-populated-list guard).
      fetchMemberIdsShared(queryClient, uid, { fresh: true })
        .then((ids) => { memberProjectIdsRef.current = ids; })
        .catch(() => {});
      // Open then completed, in order: the fresh open apply drops a task that moved
      // open->completed while hidden, then the completed re-merge re-adds it as completed
      // (hydrateCompletedTasks keeps existing state on id, so it must run second).
      (async () => {
        try {
          const rows = await fetchAllTasksShared(queryClient, uid, { fresh: true });
          applyTaskRows(rows);
        } catch {
          /* keep prior state */
        }
        await hydrateCompletedTasks({ fresh: true });
      })();
      fetchProjectsShared(queryClient, uid, { fresh: true })
        .then((rows) => applyProjectRows(rows))
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [user, queryClient, applyTaskRows, applyProjectRows, hydrateCompletedTasks]);

  // Realtime subscription for tasks - keeps all sessions in sync
  useEffect(() => {
    if (!user) return;
    const uid = user.id;

    // Preserve locally-hydrated images when a realtime row carries none: the slim task-list
    // load omits `images`, so a realtime payload for a row hydrated this session can arrive
    // image-less. TP1: the decision is the raw row's `images` KEY, not imagesReadyRef —
    // key present means the payload speaks for the column (an empty array really is
    // "removed"), key absent means it says nothing and the existing/hydrated set stands.
    const preserveImages = (incoming: Task, existing: Task | undefined, rawHasImages: boolean): Task => {
      if (rawHasImages) return incoming;
      const preserved = (existing?.images && existing.images.length > 0)
        ? existing.images
        : hydratedImagesRef.current?.get(incoming.id);
      return preserved && preserved.length > 0 ? { ...incoming, images: preserved } : incoming;
    };

    // Mirror a realtime row into the raw-row caches so a later cache read (nav remount)
    // reflects it. A status change moves the row between the open and completed caches.
    // Slim the row first (never leak `images` into the hot task-list cache); only patch a
    // cache that already holds data — fabricating one would mark it fresh and starve the
    // real fetch that populates it (completed is lazily hydrated).
    const patchCaches = (raw: any, deleted: boolean) => {
      const openKey = appDataKeys.tasks(uid);
      const completedKey = appDataKeys.completedTasks(uid);
      if (deleted) {
        queryClient.setQueryData(openKey, (prev: any[] | undefined) => prev ? prev.filter((r: any) => r.id !== raw.id) : prev);
        queryClient.setQueryData(completedKey, (prev: any[] | undefined) => prev ? prev.filter((r: any) => r.id !== raw.id) : prev);
        return;
      }
      const slim = slimTaskRow(raw);
      const completed = slim.status === 'completed';
      const targetKey = completed ? completedKey : openKey;
      const otherKey = completed ? openKey : completedKey;
      queryClient.setQueryData(targetKey, (prev: any[] | undefined) => {
        if (!prev) return prev;
        const idx = prev.findIndex((r: any) => r.id === slim.id);
        if (idx === -1) return [slim, ...prev];
        const next = prev.slice();
        next[idx] = slim;
        return next;
      });
      queryClient.setQueryData(otherKey, (prev: any[] | undefined) => prev ? prev.filter((r: any) => r.id !== slim.id) : prev);
    };

    // INSERT/UPDATE share one upsert: replace by id, else append. Handles a completed row
    // absent from state (a completed-task UPDATE), so the Done set stays live without a
    // refetch. Never seed an empty list mid-cold-load — the initial load will populate it.
    const upsertTask = (raw: any) => {
      const incoming = transformDbTask(raw);
      const rawHasImages = !!raw && Object.prototype.hasOwnProperty.call(raw, 'images');
      setAllTasks(prev => {
        const idx = prev.findIndex(t => t.id === incoming.id);
        if (idx === -1) {
          if (prev.length === 0) return prev;
          return [...prev, preserveImages(incoming, undefined, rawHasImages)];
        }
        const next = prev.slice();
        next[idx] = preserveImages(incoming, prev[idx], rawHasImages);
        return next;
      });
      patchCaches(raw, false);
    };

    const channel = supabase
      .channel(`tasks-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'focusos_tasks',
          filter: `user_id=eq.${user.id}`
        },
        (payload) => {
          upsertTask(payload.new);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'focusos_tasks',
          filter: `user_id=eq.${user.id}`
        },
        (payload) => {
          // No projectRefreshTrigger bump: the sidebar recomputes shared-project
          // visibility off its own tasks channel, and the auto-eject effect handles the
          // currently-viewed shared project off this allTasks change.
          upsertTask(payload.new);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'focusos_tasks',
          filter: `user_id=eq.${user.id}`
        },
        (payload) => {
          const deletedTaskId = (payload.old as any).id;
          setAllTasks(prev => prev.filter(t => t.id !== deletedTaskId));
          patchCaches({ id: deletedTaskId }, true);
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('Realtime connected');
          if (hasSubscribedOnceRef.current) {
            // Reconnect — refetch in case we missed events while disconnected
            resyncTasksRef.current();
          } else {
            hasSubscribedOnceRef.current = true;
          }
        } else if (status === 'CHANNEL_ERROR') {
          console.error('Realtime error:', err);
        }
      });

    // Realtime subscription for shared items status updates (sender sees recipient accept/decline/complete)
    const sharedItemsChannel = supabase
      .channel(`shared-items-sender-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'focusos_shared_items',
          filter: `sender_user_id=eq.${user.id}`
        },
        () => {
          fetchSenderSharedItems();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(sharedItemsChannel);
    };
  }, [user, transformDbTask, fetchSenderSharedItems, queryClient]);

  // Resolve the view BEFORE anything paints — state adjusted DURING render (the
  // react.dev "you might not need an effect" pattern). The old post-paint effect let the
  // first content render use the hardcoded defaults (grid, no filter), which mounted the
  // full unfiltered task set for a visible burst (the 07-25 422-card flash + ~1s freeze)
  // before tearing it down. Setting state here re-renders synchronously pre-commit, so a
  // wrong view can never reach the screen. Runs once per mount (preferencesLoaded latch);
  // deliberately does NOT wait for projects — a project-id view applies optimistically and
  // the effect below corrects a deleted project once projects have loaded.
  if (user && preferences && !preferencesLoaded) {
    setAppliedSearch(window.location.search);
    const urlParams = new URLSearchParams(window.location.search);
    const viewParam = urlParams.get('view');

    if (viewParam === 'past-due' || viewParam === 'today' || viewParam === 'unassigned') {
      setSelectedSpecialList(viewParam);
      setSelectedProjectId(null);
    } else if (viewParam === 'projects') {
      setSelectedSpecialList(null);
    } else if (viewParam) {
      // Deep-linked project id — apply optimistically, existence re-checked below.
      setSelectedProjectId(viewParam);
      setSelectedSpecialList(null);
    } else if (preferences.default_view === 'today') {
      setSelectedSpecialList('today');
      setSelectedProjectId(null);
    } else if (preferences.default_view === 'unassigned') {
      setSelectedSpecialList('unassigned');
      setSelectedProjectId(null);
    } else if (preferences.default_view && preferences.default_view !== 'home') {
      // Project-id default — optimistic, corrected below if the project is gone.
      setSelectedProjectId(preferences.default_view);
      setSelectedSpecialList(null);
    } else {
      setSelectedSpecialList('today');
      setSelectedProjectId(null);
    }

    // Apply display mode
    const modeMap: Record<string, 'list' | 'grid' | 'gantt' | 'time-tracking'> = {
      'list': 'list',
      'grid': 'grid',
      'gantt': 'gantt',
      'time': 'time-tracking'
    };
    setViewMode(modeMap[preferences.default_display_mode] || 'list');

    // Apply task filter
    setActiveTab(preferences.default_task_filter);

    setPreferencesLoaded(true);
  }

  // Retry after a failed/suspicious initial load — re-arms the initial-load effect;
  // the poisoned cache entry was evicted at detection time, so this refetches for real.
  const handleRetryLoad = useCallback(() => {
    setLoadFailed(false);
    setInitialLoadComplete(false);
  }, []);

  // Warm-cache start DURING render (flicker fault A, 2026-07-25): the warm apply used
  // to happen in the post-paint initial-load effect, so every /app re-entry painted the
  // (now opaque) skeleton for ~4 frames while the data sat ready in the cache. Applying
  // the cached rows here commits them before first paint — the skeleton renders only on
  // genuinely cold loads. The initial-load effect still runs afterwards: its warm branch
  // re-applies the same rows (idempotent) and handles shared maps / member ids.
  if (user && !initialLoadComplete && !warmStartDone) {
    setWarmStartDone(true);
    const warmTasks = queryClient.getQueryData(appDataKeys.tasks(user.id)) as any[] | undefined;
    const warmProjects = queryClient.getQueryData(appDataKeys.projects(user.id)) as any[] | undefined;
    if (warmTasks && warmTasks.length > 0 && warmProjects) {
      setAllTasks(warmTasks.map(transformDbTask));
      const toWarmProject = (p: RawProjectRow): Project => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isShared: p.is_shared ?? false,
        userId: p.user_id,
        archivedAt: p.archived_at ?? null,
        parentProjectId: isSubProject(p) ? p.parent_project_id : null,
        timer: { totalSeconds: 0, isRunning: false },
      });
      // Same active/full split as applyProjectRows (kept inline here — this branch
      // must commit synchronously during render, not via a callback that could be
      // stale on the first paint).
      setProjects(warmProjects.filter((p: RawProjectRow) => !isProjectArchived(p)).map(toWarmProject));
      // NOTE: allProjectsForReports is deliberately NOT set here. This block runs
      // once during render (warmStartDone latch); adding a fourth during-render
      // setState here shifted render timing enough to intermittently swallow a
      // tap that lands in the same frame (bisected: it broke the reorder-mode
      // gesture spec under full-suite load, 2026-08-22). The post-paint
      // initial-load effect calls applyProjectRows(cachedProjects) a beat later,
      // which DOES populate allProjectsForReports — so the archived-inclusive
      // list is correct after the first paint. The only cost is that a warm
      // start landing DIRECTLY on an already-archived selected project shows its
      // header name one paint late, which is invisible; the fallback effect is
      // length-guarded so it never false-ejects during that window.
      setFullDataLoaded(true);
    }
  }

  // ---- P4 roll-up scope -----------------------------------------------------
  // A TOP-LEVEL project's view is the project PLUS its active sub-projects: the
  // list, the Gantt and the time chart all read `sortedTasks`, so widening the
  // scope here is what makes every one of them tree-aware at once. Derived
  // DURING render from the same state the drawer reads (no effect, no extra
  // state, nothing corrected after paint).
  //
  // Deliberately narrow:
  //  - only a top-level project rolls up; a SUB's own view shows exactly its own
  //    tasks (subProjectIdsOf returns an empty set for a sub).
  //  - `projects` is the ACTIVE list, so an archived sub never drags its tasks
  //    into its parent's view.
  //  - the selected row is resolved archived-inclusive, because an archived
  //    project stays selected until the user navigates away.
  const selectedSubProjectIds = useMemo(() => {
    if (!selectedProjectId) return new Set<string>();
    const row = projects.find(p => p.id === selectedProjectId)
      ?? allProjectsForReports.find(p => p.id === selectedProjectId);
    if (row?.parentProjectId) return new Set<string>();
    return subProjectIdsOf(projects, selectedProjectId);
  }, [selectedProjectId, projects, allProjectsForReports]);

  // "Does this task belong to the CURRENT project view?" — the one predicate
  // every belongs-to-this-view test goes through, so the roll-up can never be
  // half-applied (list says yes, timer glow says no).
  const isTaskInSelectedScope = useCallback(
    (task: Task) => {
      if (!selectedProjectId) return false;
      if (task.projectId === selectedProjectId) return true;
      return !!task.projectId && selectedSubProjectIds.has(task.projectId);
    },
    [selectedProjectId, selectedSubProjectIds],
  );

  // Gantt grouping input: only a top-level project WITH active subs groups its
  // chart; everything else leaves the Gantt exactly as it was before P4.
  const ganttGroupBy = useMemo(() => {
    if (!selectedProjectId || selectedSubProjectIds.size === 0) return undefined;
    const subs = projects.filter(p => selectedSubProjectIds.has(p.id));
    return subs.length > 0 ? { parentId: selectedProjectId, subs } : undefined;
  }, [selectedProjectId, selectedSubProjectIds, projects]);

  // Per-sub caption for a task shown in a PARENT's view: which sub-project it
  // actually lives in. Undefined for the parent's own tasks (nothing to say) and
  // for anything outside the roll-up scope, so a fuzzy search result from an
  // unrelated project never picks up a chip. Archived-inclusive lookup so a sub
  // archived mid-session still resolves its name/colour instead of blanking.
  const scopeLabelFor = useCallback(
    (task: Task): { name: string; color: string } | undefined => {
      if (!task.projectId || task.projectId === selectedProjectId) return undefined;
      if (!selectedSubProjectIds.has(task.projectId)) return undefined;
      const sub = projects.find(p => p.id === task.projectId)
        ?? allProjectsForReports.find(p => p.id === task.projectId);
      return sub ? { name: sub.name, color: sub.color } : undefined;
    },
    [selectedProjectId, selectedSubProjectIds, projects, allProjectsForReports],
  );

  // Deleted/unavailable project fallback: an optimistically-applied project id (deep link
  // or stale default_view) falls back to Today once the real project list has loaded and
  // does not contain it. Guarded on a non-empty list so a transient empty apply can never
  // false-trigger it. Checked against `allProjectsForReports` (archived included), NOT the
  // active-only `projects` — otherwise this fires the instant an archived project is
  // selected (it's deliberately absent from `projects`) and immediately ejects back to
  // Today, even though the project still exists and is meant to stay reachable/selected.
  useEffect(() => {
    if (!initialLoadComplete || !selectedProjectId || allProjectsForReports.length === 0) return;
    if (!allProjectsForReports.some(p => p.id === selectedProjectId)) {
      setSelectedSpecialList('today');
      setSelectedProjectId(null);
    }
  }, [initialLoadComplete, allProjectsForReports, selectedProjectId]);

  useEffect(() => {
    if (!preferences) return;

    setGlobalCardView(
      isMobile
        ? (preferences.default_task_card_view_mobile ?? 'compact')
        : (preferences.default_task_card_view ?? 'compact')
    );
    setExpandedTaskIds(new Set());
  }, [isMobile, preferences?.default_task_card_view, preferences?.default_task_card_view_mobile]);

  // React to URL search param changes (BottomNav clicks) DURING render — the old
  // post-paint effect let one stale-list frame slip through on every in-app view
  // switch (flicker fault B, 2026-07-25: Past Due list under a ?view=today URL for
  // 19ms). Latched on the actual search string, so in-app selections that don't
  // change the URL are never clobbered.
  if (preferencesLoaded && appliedSearch !== location.search) {
    setAppliedSearch(location.search);
    const urlParams = new URLSearchParams(location.search);
    const viewParam = urlParams.get('view');
    if (viewParam === 'past-due' || viewParam === 'today' || viewParam === 'unassigned') {
      setSelectedSpecialList(viewParam);
      setSelectedProjectId(null);
    } else if (viewParam === 'projects') {
      setSelectedSpecialList(null);
    }
  }

  // Auto-open sidebar when arriving via openSidebar param (mobile + desktop)
  // Apply the user's default_view preference so the right tasks load
  useEffect(() => {
    if (!preferencesLoaded || !preferences) return;
    const urlParams = new URLSearchParams(location.search);
    const wantsOpen = urlParams.get('openSidebar') === 'true';

    // Reset the latch once the param has left the URL (strip committed), so the
    // NEXT arrival with ?openSidebar=true is handled afresh.
    if (!wantsOpen) {
      openSidebarHandledRef.current = false;
      return;
    }

    // Already consumed this arrival — a `projects` re-run before the strip
    // commits must not re-raise the open request (would reopen the drawer).
    if (openSidebarHandledRef.current) return;
    openSidebarHandledRef.current = true;

    {
      // Apply the user's default_view to select the right project/list
      const dv = preferences.default_view;
      if (dv === 'today') {
        setSelectedSpecialList('today');
        setSelectedProjectId(null);
      } else if (dv === 'unassigned') {
        setSelectedSpecialList('unassigned');
        setSelectedProjectId(null);
      } else if (dv && dv !== 'home') {
        // It's a project ID
        const projectExists = projects.some(p => p.id === dv);
        if (projectExists) {
          setSelectedProjectId(dv);
          setSelectedSpecialList(null);
        } else {
          setSelectedSpecialList('today');
          setSelectedProjectId(null);
        }
      }

      // On mobile, signal the child component to call setOpenMobile(true)
      if (isMobile) {
        setOpenSidebarRequested(true);
      }

      // Strip the param from the URL
      urlParams.delete('openSidebar');
      const cleanSearch = urlParams.toString();
      navigate(cleanSearch ? `/app?${cleanSearch}` : '/app', { replace: true });
    }
  }, [location.search, preferencesLoaded, preferences, isMobile, navigate, projects]);

  // ?tour=tasks | ?tour=projects handshake. The Projects drawer on the HOST pages
  // (/home, /meetings, /meetings/:id — ProjectsDrawerHost) shows the same Help menu,
  // but those pages cannot start /app's tours: the tour state, the demo rows and the
  // spotlight targets all live here. So the host's handler navigates to /app with this
  // param and hands off. Same one-shot latch discipline as ?openSidebar above: consume
  // once, strip the param, reset when it has left the URL. Gated on a finished initial
  // load so the spotlight measures real, painted targets rather than the skeleton.
  useEffect(() => {
    if (!user || !preferencesLoaded || !initialLoadComplete) return;
    const urlParams = new URLSearchParams(location.search);
    const wants = urlParams.get('tour');

    if (wants !== 'tasks' && wants !== 'projects') {
      tourParamHandledRef.current = false;
      return;
    }
    if (tourParamHandledRef.current) return;
    tourParamHandledRef.current = true;

    // Strip first so a re-run before the tour's own state lands cannot double-start it.
    urlParams.delete('tour');
    const cleanSearch = urlParams.toString();
    navigate(cleanSearch ? `/app?${cleanSearch}` : '/app', { replace: true });

    if (wants === 'tasks') {
      handleStartTaskTour();
    } else {
      handleStartProjectsTour();
    }
  }, [location.search, user, preferencesLoaded, initialLoadComplete, navigate]);

  // Reset reorder mode when switching projects/views
  useEffect(() => {
    setIsReorderMode(false);
  }, [selectedProjectId, selectedSpecialList]);

  // Fallback auto-eject: shared project with no visible active tasks should return to Today's To-Do
  useEffect(() => {
    if (!selectedProjectId || !initialLoadComplete || !fullDataLoaded) return;

    const currentProject = projects.find(p => p.id === selectedProjectId);
    if (!currentProject?.isShared) return;

    // Roll-up scope (P4): the eject means "this VIEW is empty", so a shared
    // parent whose only remaining tasks sit in its subs must NOT eject.
    const hasVisibleActiveTasks = allTasks.some(
      t => isTaskInSelectedScope(t) && t.status !== 'completed' && !t.changeRequestMessage
    );

    if (!hasVisibleActiveTasks) {
      setSelectedSpecialList('today');
      setSelectedProjectId(null);
      setProjectRefreshTrigger(prev => prev + 1);
    }
  }, [selectedProjectId, projects, allTasks, initialLoadComplete, fullDataLoaded, isTaskInSelectedScope]);

  // Auto-show onboarding tour for new users
  useEffect(() => {
    if (preferences && !preferences.has_completed_onboarding && initialLoadComplete) {
      // Small delay to let the UI settle
      const timer = setTimeout(() => setShowTour(true), 500);
      return () => clearTimeout(timer);
    }
  }, [preferences, initialLoadComplete]);

  const handleTourComplete = () => {
    setShowTour(false);
    markOnboardingComplete();
  };

  const handleOpenSidebarHandled = useCallback(() => setOpenSidebarRequested(false), []);

  const handleHelpClick = () => {
    setShowTour(true);
  };

  const handleStartTaskTour = async () => {
    if (!user) return;

    // Calculate dates
    const today = new Date();
    const startDate = addDays(today, 7);
    const endDate = addDays(today, 14);
    const dueDate = addDays(today, 14);

    // Create the sample task
    const sampleTask: Task = {
      id: crypto.randomUUID(),
      title: 'Plan Holidays',
      description: `Choose destination, Find accommodation and book a flight

https://www.booking.com
https://www.skyscanner.com`,
      priority: 'high',
      status: 'todo',
      startDate,
      endDate,
      dueDate,
      images: [],
      timer: {
        totalSeconds: 0,
        isRunning: false
      },
      projectId: undefined // Unassigned
    };

    // Insert into database
    const { data, error } = await (supabase as any).from('focusos_tasks').insert({
      user_id: user.id,
      project_id: null,
      title: sampleTask.title,
      description: sampleTask.description,
      priority: sampleTask.priority,
      status: sampleTask.status,
      start_date: sampleTask.startDate?.toISOString(),
      end_date: sampleTask.endDate?.toISOString(),
      due_date: sampleTask.dueDate?.toISOString(),
      images: [],
      timer_total_seconds: 0,
      timer_is_running: false
    }).select().single();

    if (error) {
      toast.error('Failed to create sample task for tour');
      return;
    }

    // Update task with actual ID from database
    const createdTask: Task = {
      ...sampleTask,
      id: data.id
    };

    setTaskTourTask(createdTask);
    
    // Switch to Unassigned view
    setSelectedProjectId(null);
    setSelectedSpecialList('unassigned');
    
    // Refresh tasks to show the new task
    await fetchTasks();
    
    // Start the tour - Edit dialog will open when user moves to step 2
    setShowTaskTour(true);
  };

  const handleTaskTourStepChange = (step: number) => {
    // Open Edit Task dialog when moving past Step 1 (Add Task button)
    if (step >= 1 && taskTourTask) {
      setEditingTask(taskTourTask);
    } else if (step === 0) {
      // Close dialog when going back to Step 1
      setEditingTask(null);
    }
  };

  const handleTaskTourComplete = async () => {
    setShowTaskTour(false);
    setEditingTask(null);
    
    // Delete the sample "Plan Holidays" task
    if (taskTourTask) {
      try {
        await (supabase as any).from('focusos_tasks').delete().eq('id', taskTourTask.id);
        setAllTasks(prev => prev.filter(t => t.id !== taskTourTask.id));
      } catch (error) {
        console.error('Failed to delete tour task:', error);
      }
    }
    
    setTaskTourTask(null);
    
    // Mark task tour as complete in preferences
    await markTaskTourComplete();
    
    // Navigate to Today's To-Do list after tour completes
    setSelectedSpecialList('today');
    setSelectedProjectId(null);
    
    toast.success('Tasks Tour completed!');
  };

  // Projects Tour handlers
  const handleStartProjectsTour = async () => {
    if (!user) return;

    // Create 2 demo projects
    const demoProject1 = {
      name: 'Demo Project 1',
      color: '#3b82f6',
      user_id: user.id
    };
    const demoProject2 = {
      name: 'Demo Project 2',
      color: '#10b981',
      user_id: user.id
    };

    const { data: project1Data, error: project1Error } = await (supabase as any)
      .from('focusos_projects')
      .insert(demoProject1)
      .select()
      .single();

    if (project1Error) {
      toast.error('Failed to create demo project 1');
      return;
    }

    const { data: project2Data, error: project2Error } = await (supabase as any)
      .from('focusos_projects')
      .insert(demoProject2)
      .select()
      .single();

    if (project2Error) {
      toast.error('Failed to create demo project 2');
      // Clean up project 1
      await (supabase as any).from('focusos_projects').delete().eq('id', project1Data.id);
      return;
    }

    // Create a demo task in project 1
    const demoTask = {
      user_id: user.id,
      project_id: project1Data.id,
      title: 'Demo Task - Try moving me!',
      description: 'This is a demo task. Try changing which project it belongs to using the Project dropdown.',
      priority: 'medium',
      status: 'todo',
      due_date: new Date().toISOString()
    };

    const { data: taskData, error: taskError } = await (supabase as any)
      .from('focusos_tasks')
      .insert(demoTask)
      .select()
      .single();

    if (taskError) {
      toast.error('Failed to create demo task');
      // Clean up projects
      await (supabase as any).from('focusos_projects').delete().eq('id', project1Data.id);
      await (supabase as any).from('focusos_projects').delete().eq('id', project2Data.id);
      return;
    }

    // Store tour items for cleanup
    setProjectsTourProjects([
      { id: project1Data.id, name: project1Data.name },
      { id: project2Data.id, name: project2Data.name }
    ]);
    setProjectsTourTask({
      id: taskData.id,
      title: taskData.title,
      description: taskData.description,
      priority: taskData.priority as TaskPriority,
      status: taskData.status as TaskStatus,
      dueDate: new Date(taskData.due_date),
      projectId: taskData.project_id,
      images: [],
      timer: { totalSeconds: 0, isRunning: false }
    });

    // Refresh projects list
    await fetchProjects();
    setProjectRefreshTrigger(prev => prev + 1);
    
    // Start the tour
    setLastProcessedTourStep(null);
    setProjectsTourCurrentStep(0);
    setShowProjectsTour(true);
  };

  const handleProjectsTourStepChange = async (step: number, action?: string) => {
    console.log('[Tour] Step change called:', { step, action, lastProcessedTourStep });
    
    // Always update the current displayed step (for sidebar controller)
    if (!action) {
      setProjectsTourCurrentStep(step);
    }
    
    // If action is provided, this is an action-only call - don't update lastProcessedTourStep
    // Only update lastProcessedTourStep for actual step transitions (no action)
    if (!action) {
      // Prevent duplicate processing of the same step
      if (step === lastProcessedTourStep) {
        console.log('[Tour] Skipping duplicate step:', step);
        return;
      }
      setLastProcessedTourStep(step);
      console.log('[Tour] Processing step:', step);
    } else {
      console.log('[Tour] Processing action:', action);
    }

    // Step 1 (index 1) is the color picker step - open the Create Project dialog
    if (step === 1 && !action) {
      setTourCreateDialogOpen(true);
    } else if (step !== 1 && !action) {
      // Close dialog when not on step 1 (but only on step transitions, not actions)
      setTourCreateDialogOpen(false);
    }

    if (action === 'click-project') {
      console.log('[Tour] click-project action, projectsTourProjects:', projectsTourProjects);
      if (projectsTourProjects.length > 0) {
        // Step 2 action: Select the demo project
        setSelectedProjectId(projectsTourProjects[0].id);
        setSelectedSpecialList(null);
        await fetchTasks();
      } else {
        console.error('[Tour] No demo projects available for click-project action');
      }
    } else if (action === 'show-move-task') {
      // Step 5 action: Open the task edit dialog to show project selector
      console.log('[Tour] Opening edit dialog for task');
      
      // Ensure projects are refreshed first
      await fetchProjects();
      
      // Find the task in current tasks or use stored reference
      const taskToEdit = allTasks.find(t => t.id === projectsTourTask?.id) || projectsTourTask;
      if (taskToEdit) {
        console.log('[Tour] Setting editing task:', taskToEdit.id);
        setEditingTask(taskToEdit);
      } else {
        console.error('[Tour] Could not find task to edit');
      }
    }
  };

  const handleProjectsTourComplete = async () => {
    setShowProjectsTour(false);
    setEditingTask(null);
    setTourCreateDialogOpen(false);

    // Delete demo task
    if (projectsTourTask) {
      try {
        await (supabase as any).from('focusos_tasks').delete().eq('id', projectsTourTask.id);
      } catch (error) {
        console.error('Failed to delete demo task:', error);
      }
    }

    // Delete demo projects
    for (const project of projectsTourProjects) {
      try {
        await (supabase as any).from('focusos_projects').delete().eq('id', project.id);
      } catch (error) {
        console.error('Failed to delete demo project:', error);
      }
    }

    // Clear tour state
    setProjectsTourTask(null);
    setProjectsTourProjects([]);
    setLastProcessedTourStep(null);
    setProjectsTourCurrentStep(0);

    // Mark tour as complete
    await markProjectsTourComplete();

    // Refresh UI
    await fetchProjects();
    setProjectRefreshTrigger(prev => prev + 1);
    
    // Navigate to Today's view
    setSelectedSpecialList('today');
    setSelectedProjectId(null);

    toast.success('Projects Tour completed!');
  };

  // Handle Add Task dialog open - trigger tour on first click
  const handleAddTaskDialogOpen = (open: boolean) => {
    if (open && preferences && !preferences.has_completed_task_tour) {
      // First time clicking Add Task - start the task tour instead
      handleStartTaskTour();
    } else {
      setAddTaskDialogOpen(open);
    }
  };

  const handleAddTask = async (newTask: Task) => {
    if (!user) return;
    const { data, error } = await (supabase as any).from('focusos_tasks').insert({
      user_id: user.id,
      project_id: newTask.projectId || null,
      title: newTask.title,
      description: newTask.description,
      priority: newTask.priority,
      status: newTask.status,
      start_date: newTask.startDate?.toISOString(),
      end_date: newTask.endDate?.toISOString(),
      due_date: newTask.dueDate?.toISOString(),
      images: newTask.images || [],
      timer_total_seconds: 0,
      timer_is_running: false
    }).select().single();
    if (error) {
      toast.error('Failed to create task');
      return;
    }
    // Optimistic insert as a safety net in case realtime is briefly disconnected.
    // The realtime INSERT handler dedupes by id, so no duplicate row will appear.
    if (data) {
      const inserted = transformDbTask(data);
      // TP1: keep this session's hydrated map in step with what was just written, so a
      // later completed merge or an image-less realtime row preserves the right set.
      if (!hydratedImagesRef.current) hydratedImagesRef.current = new Map();
      hydratedImagesRef.current.set(inserted.id, inserted.images || []);
      setAllTasks(prev => prev.length === 0 || prev.some(t => t.id === inserted.id) ? prev : [...prev, inserted]);
    }
    // Toast is fired by AddTaskDialog; do not duplicate it here.
  };
  const handleUpdateTask = async (updatedTask: Task) => {
    // Collaborative project completion gating:
    // If a collaborator (non-owner) tries to mark a task as 'completed' in a shared project,
    // instead set completedByEmail so the owner can acknowledge via "Move to Done"
    const taskProject = projects.find(p => p.id === updatedTask.projectId);
    const originalTask = allTasks.find(t => t.id === updatedTask.id);
    const isCollaboratorCompletion = taskProject?.isShared 
      && taskProject?.userId !== user?.id 
      && updatedTask.status === 'completed' 
      && originalTask?.status !== 'completed';
    
    if (isCollaboratorCompletion) {
      // Collaborator marks complete → set completedByEmail but revert status to previous
      updatedTask = {
        ...updatedTask,
        status: originalTask?.status || 'todo',
        completedByEmail: user?.email || 'unknown',
      };
    }

    // If the task's project changed, recalculate sort_order so it lands at the
    // TOP of its priority group in the destination project (list is sorted asc).
    const originalForMove = originalTask ?? allTasks.find(t => t.id === updatedTask.id);
    const projectChanged = !!updatedTask.projectId
      && updatedTask.projectId !== originalForMove?.projectId;
    let nextSortOrder = updatedTask.sortOrder ?? 0;
    if (projectChanged) {
      const { data: topRow } = await (supabase as any)
        .from('focusos_tasks')
        .select('sort_order')
        .eq('project_id', updatedTask.projectId)
        .eq('priority', updatedTask.priority)
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      nextSortOrder = ((topRow?.sort_order ?? 0) as number) - 1;
      updatedTask = { ...updatedTask, sortOrder: nextSortOrder };
    }

    // Optimistic update: Update local state immediately to prevent list jumping
    setAllTasks(prevTasks => prevTasks.map(task => task.id === updatedTask.id
      ? ((updatedTask.images && updatedTask.images.length > 0) || imagesReadyRef.current
          ? updatedTask
          : { ...updatedTask, images: task.images })
      : task));

    // Update database in background
    const {
      error
    } = await (supabase as any).from('focusos_tasks').update({
      title: updatedTask.title,
      description: updatedTask.description,
      priority: updatedTask.priority,
      status: updatedTask.status,
      start_date: updatedTask.startDate?.toISOString(),
      end_date: updatedTask.endDate?.toISOString(),
      due_date: updatedTask.dueDate?.toISOString(),
      // Pre-hydration an empty array means "images not loaded yet", not "removed" —
      // omit the column so a save in that window can't wipe stored images.
      ...((updatedTask.images && updatedTask.images.length > 0) || imagesReadyRef.current
        ? { images: updatedTask.images || [] } : {}),
      timer_total_seconds: updatedTask.timer.totalSeconds,
      timer_is_running: updatedTask.timer.isRunning,
      timer_start_time: updatedTask.timer.startTime,
      project_id: updatedTask.projectId || null,
      sort_order: nextSortOrder,
      completed_by_email: updatedTask.completedByEmail || null,
    }).eq('id', updatedTask.id);
    if (error) {
      toast.error('Failed to update task');
      fetchTasks();
      return;
    }

    // TP1: the `images` column was written above (attach or remove), so record the new
    // set here too — the hydrated map is what a later merge or image-less realtime row
    // falls back to, and a stale entry would resurrect images the user just removed.
    if ((updatedTask.images && updatedTask.images.length > 0) || imagesReadyRef.current) {
      if (!hydratedImagesRef.current) hydratedImagesRef.current = new Map();
      hydratedImagesRef.current.set(updatedTask.id, updatedTask.images || []);
    }

    // Bidirectional completion sync for shared tasks
    if (updatedTask.status === 'completed') {
      try {
        // Check if this task is a shared original (sender's task) — sync to recipient's clone
        const { data: asOriginal } = await (supabase as any)
          .from('focusos_shared_items')
          .select('recipient_task_id')
          .eq('item_id', updatedTask.id)
          .eq('item_type', 'task')
          .eq('status', 'accepted')
          .not('recipient_task_id', 'is', null);

        if (asOriginal && asOriginal.length > 0) {
          for (const si of asOriginal) {
            // Use edge function to update recipient's task (bypasses RLS)
            await supabase.functions.invoke('focusos-complete-shared-task', {
              body: {},
            }).catch(() => {});
            // Actually we need a different approach - use the share_token URL
          }
        }

        // Check if this task is a recipient's clone — sync back to sender's original
        const { data: asClone } = await (supabase as any)
          .from('focusos_shared_items')
          .select('item_id, sender_email')
          .eq('recipient_task_id', updatedTask.id)
          .eq('item_type', 'task')
          .eq('status', 'accepted');

        // For cross-user updates we need a service-role function
        // Let's invoke the sync via edge function
        if ((asOriginal && asOriginal.length > 0) || (asClone && asClone.length > 0)) {
          await supabase.functions.invoke('focusos-sync-task-completion', {
            body: {
              taskId: updatedTask.id,
              completedByEmail: user?.email || 'unknown',
            },
          }).catch((err) => console.error('Sync completion error:', err));
        }
      } catch (err) {
        console.error('Completion sync lookup error:', err);
      }

      // Auto-redirect: if the last task in a shared project was just completed, go to Today's To-Do
      if (selectedProjectId && isTaskInSelectedScope(updatedTask)) {
        const currentProject = projects.find(p => p.id === selectedProjectId);
        if (currentProject?.isShared) {
          // Same roll-up scope as the list: a parent view still holding active
          // tasks in a SUB is not empty, so it must not redirect (P4).
          const remainingActive = allTasks.filter(
            t => isTaskInSelectedScope(t) && t.id !== updatedTask.id && t.status !== 'completed' && !t.changeRequestMessage
          );
          if (remainingActive.length === 0) {
            setSelectedSpecialList('today');
            setSelectedProjectId(null);
            setProjectRefreshTrigger(prev => prev + 1);
          }
        }
      }
    }
  };

  // Batch update for drag-and-drop reordering
  const handleBatchUpdateTasks = async (updatedTasks: Task[]) => {
    // Optimistic update
    setAllTasks(prevTasks => {
      const updateMap = new Map(updatedTasks.map(t => [t.id, t]));
      return prevTasks.map(task => updateMap.get(task.id) || task);
    });

    // Batch DB updates in parallel
    const results = await Promise.all(
      updatedTasks.map(t =>
        (supabase as any).from('focusos_tasks').update({
          priority: t.priority,
          sort_order: t.sortOrder ?? 0,
        }).eq('id', t.id)
      )
    );

    if (results.some(r => r.error)) {
      toast.error('Failed to reorder tasks');
      fetchTasks();
    }
  };
  const handleTaskClick = (taskId: string) => {
    setExpandedTaskIds(prev => {
      if (prev.has(taskId) && prev.size === 1) {
        return new Set();
      }
      return new Set([taskId]);
    });
  };

  const handleAssignTask = (task: Task) => {
    setTaskToShare(task);
    setShareDialogOpen(true);
  };

  const handleRequestChanges = (task: Task) => {
    setChangesNeededTask(task);
    setChangesNeededMessage('');
    setChangesNeededDialogOpen(true);
  };

  const handleSubmitChangesNeeded = async () => {
    if (!changesNeededTask || !changesNeededMessage.trim()) return;
    setChangesNeededLoading(true);
    try {
      const { error } = await supabase.functions.invoke('focusos-request-changes', {
        body: {
          taskId: changesNeededTask.id,
          message: changesNeededMessage.trim(),
          recipientEmail: changesNeededTask.completedByEmail || undefined,
        },
      });
      if (error) throw error;

      // Optimistic: clear completedByEmail on sender's task and revert shared recipient status
      const recipientEmail = changesNeededTask.completedByEmail;
      const cleared = { ...changesNeededTask, completedByEmail: undefined, changeRequestMessage: undefined };
      setAllTasks(prev => prev.map(t => t.id === cleared.id ? cleared : t));
      
      // Optimistic: revert the specific recipient's status in senderSharedMap
      if (recipientEmail) {
        setSenderSharedMap(prev => {
          const recipients = prev[changesNeededTask.id];
          if (!recipients) return prev;
          return {
            ...prev,
            [changesNeededTask.id]: recipients.map(r =>
              r.email === recipientEmail ? { ...r, status: 'accepted' } : r
            ),
          };
        });
      }

      toast.success('Changes requested — the recipient has been notified.');
      setChangesNeededDialogOpen(false);
      setChangesNeededTask(null);
      setChangesNeededMessage('');
    } catch (err: any) {
      console.error('Request changes error:', err);
      toast.error('Failed to request changes');
    } finally {
      setChangesNeededLoading(false);
    }
  };

  const handleDismissChangeRequest = async (task: Task) => {
    // Clear the change_request_message on the recipient's task
    const { error } = await (supabase as any).from('focusos_tasks').update({
      change_request_message: null,
    }).eq('id', task.id);
    if (error) {
      toast.error('Failed to dismiss');
      return;
    }
    const updated = { ...task, changeRequestMessage: undefined };
    setAllTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
  };

  const handleDeleteTask = async (task: Task) => {
    // Recipients cannot delete (they received a shared task clone)
    if (task.assignedToEmail) {
      toast.error("You can't delete a task that was shared with you");
      return;
    }
    // Collaborators on shared projects cannot delete — only the project owner can
    const taskProject = projects.find(p => p.id === task.projectId);
    if (taskProject?.isShared && taskProject?.userId !== user?.id) {
      toast.error('Only the project owner can delete tasks in a collaborative project');
      return;
    }

    // Optimistic removal
    const prevAllTasks = allTasks;
    setAllTasks(prev => prev.filter(t => t.id !== task.id));

    try {
      // If this task was shared with recipients, delete recipient clones + shared_items rows first
      const { data: sharedRows } = await (supabase as any)
        .from('focusos_shared_items')
        .select('id, recipient_task_id')
        .eq('item_id', task.id)
        .eq('item_type', 'task');

      if (sharedRows && sharedRows.length > 0) {
        const recipientTaskIds = sharedRows
          .map((r: any) => r.recipient_task_id)
          .filter(Boolean);
        if (recipientTaskIds.length > 0) {
          await (supabase as any)
            .from('focusos_tasks')
            .delete()
            .in('id', recipientTaskIds);
        }
        const sharedIds = sharedRows.map((r: any) => r.id);
        // Attempt shared_items cleanup (RLS may not allow DELETE — nulling recipient_task_id is a safe fallback)
        // O12 finding 2: exclude cancelled rows — they are kept as history
        // (no DELETE policy) and must never be rewritten to 'declined'.
        await (supabase as any)
          .from('focusos_shared_items')
          .update({ recipient_task_id: null, status: 'declined' })
          .in('id', sharedIds)
          .neq('status', 'cancelled');
      }

      const { error } = await (supabase as any)
        .from('focusos_tasks')
        .delete()
        .eq('id', task.id);

      if (error) throw error;
      toast.success('Task deleted');
    } catch (err: any) {
      console.error('Delete task error:', err);
      // Roll back optimistic removal
      setAllTasks(prevAllTasks);
      toast.error('Failed to delete task');
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  const handleStartEditingProject = () => {
    const currentProject = projects.find(p => p.id === selectedProjectId);
    if (currentProject) {
      setEditedProjectName(currentProject.name);
      setIsEditingProjectName(true);
    }
  };

  const handleSaveProjectName = async () => {
    if (!selectedProjectId || !editedProjectName.trim()) {
      setIsEditingProjectName(false);
      return;
    }

    try {
      const { error } = await (supabase as any)
        .from('focusos_projects')
        .update({ name: editedProjectName.trim() })
        .eq('id', selectedProjectId);

      if (error) throw error;

    // Update local state
    setProjects(projects.map(p => 
      p.id === selectedProjectId ? { ...p, name: editedProjectName.trim() } : p
    ));
    
    // Trigger sidebar refresh
    setProjectRefreshTrigger(prev => prev + 1);
    
    setIsEditingProjectName(false);
    toast.success('Project name updated');
    } catch (error) {
      console.error('Error updating project name:', error);
      toast.error('Failed to update project name');
    }
  };

  const handleDeleteProject = async () => {
    if (!selectedProjectId) return;

    try {
      // Delete all tasks in the project first
      const { error: tasksError } = await (supabase as any)
        .from('focusos_tasks')
        .delete()
        .eq('project_id', selectedProjectId);

      if (tasksError) throw tasksError;

      // Delete the project
      const { error: projectError } = await (supabase as any)
        .from('focusos_projects')
        .delete()
        .eq('id', selectedProjectId);

      if (projectError) throw projectError;

      // Update local state
      setProjects(projects.filter(p => p.id !== selectedProjectId));
      setAllTasks(prev => prev.filter(t => t.projectId !== selectedProjectId));
      
      // Reset selection to "Today" view
      setSelectedProjectId(null);
      setSelectedSpecialList('today');
      
      // Trigger sidebar refresh
      setProjectRefreshTrigger(prev => prev + 1);
      
      toast.success('Project and all its tasks deleted');
    } catch (error) {
      console.error('Error deleting project:', error);
      toast.error('Failed to delete project');
    }
  };

  // Archive: sets archived_at, keeps the project and its tasks (timer totals
  // included) — unlike Delete, nothing is removed from the database. Same
  // local-state + refresh-trigger shape as handleDeleteProject above.
  const handleArchiveProject = async () => {
    if (!selectedProjectId) return;
    const archivedAt = new Date().toISOString();
    const targetId = selectedProjectId;
    // CASCADE (P3): archiving a parent archives its sub-projects with it, in ONE
    // statement, so the pair can never end up half-archived. `.or()` keeps the
    // same RLS-scoped shape the `.eq('id', …)` form had — a sub-project row is
    // owned by the same user. Restoring the parent reverses both (see
    // handleRestoreProject).
    const cascadeIds = new Set([
      targetId,
      ...allProjectsForReports.filter(p => p.parentProjectId === targetId).map(p => p.id),
    ]);

    try {
      const { error } = await (supabase as any)
        .from('focusos_projects')
        // The pin goes with it (O8): an archived project leaves the drawer's
        // active list entirely, so leaving it pinned would hold a slot of the
        // 5-pin cap that nothing on screen can show or release.
        .update({ archived_at: archivedAt, pinned_at: null })
        .or(`id.eq.${targetId},parent_project_id.eq.${targetId}`);

      if (error) throw error;

      // Update local state: drop from the active list, keep it (marked) in the
      // full report-facing list so TimeTrackingChart still resolves its name.
      setProjects(projects.filter(p => !cascadeIds.has(p.id)));
      setAllProjectsForReports(prev => prev.map(p =>
        cascadeIds.has(p.id) ? { ...p, archivedAt, pinnedAt: null } : p
      ));

      // Reset selection to "Today" view — mirrors handleDeleteProject; an
      // archived project is no longer selectable via the sidebar.
      setSelectedProjectId(null);
      setSelectedSpecialList('today');

      // Refresh the SHARED projects cache first (fresh), THEN bump the sidebar
      // trigger: the drawer's own fetch reads that cache non-fresh, so bumping
      // before the refetch lands would show the pre-archive snapshot until the
      // 5-min stale window expired. Sequencing here keeps the drawer's effect
      // untouched (a refetch-on-bump inside the drawer broke the reorder-mode
      // gesture spec — bisected 2026-08-22).
      await fetchProjects();
      setProjectRefreshTrigger(prev => prev + 1);

      toast.success('Project archived');
    } catch (error) {
      console.error('Error archiving project:', error);
      toast.error('Failed to archive project');
    }
  };

  // Restore: reverse of handleArchiveProject above — clears archived_at, adds
  // the project back into the active list (archiving removed it) and clears
  // its archivedAt mark in the full report-facing list. Unlike Archive this
  // does NOT reset selectedProjectId/selectedSpecialList: the project stays
  // selected, now shown as active (header/actions re-derive that during
  // render from allProjectsForReports the instant this state commits, no
  // effect required). No confirm dialog — Archive already gates the
  // destructive-feeling half of this pair.
  const handleRestoreProject = async () => {
    if (!selectedProjectId) return;
    const targetId = selectedProjectId;
    // Mirror image of the archive cascade above: restoring a parent restores the
    // sub-projects that went down with it.
    const cascadeIds = new Set([
      targetId,
      ...allProjectsForReports.filter(p => p.parentProjectId === targetId).map(p => p.id),
    ]);

    try {
      // No `as any` here (unlike the neighbouring calls in this file): the
      // generated Database type already covers focusos_projects.archived_at,
      // so the typed client checks this update for free.
      const { error } = await supabase
        .from('focusos_projects')
        .update({ archived_at: null })
        .or(`id.eq.${targetId},parent_project_id.eq.${targetId}`);

      if (error) throw error;

      const restored = allProjectsForReports
        .filter(p => cascadeIds.has(p.id) && !projects.some(a => a.id === p.id))
        .map(p => ({ ...p, archivedAt: null }));
      if (restored.length > 0) {
        setProjects([...projects, ...restored]);
      }
      setAllProjectsForReports(allProjectsForReports.map(p =>
        cascadeIds.has(p.id) ? { ...p, archivedAt: null } : p
      ));

      // Same sequencing as handleArchiveProject: fresh shared refetch, then bump.
      await fetchProjects();
      setProjectRefreshTrigger(prev => prev + 1);

      toast.success('Project restored');
    } catch (error) {
      console.error('Error restoring project:', error);
      toast.error('Failed to restore project');
    }
  };

  const openNewSubProjectDialog = (parentId: string) => setNewSubParentId(parentId);

  // Move to… — re-parents the selected project. `targetParentId === null` means
  // "Top level (no parent)", which is always allowed. Same local-state +
  // fresh-refetch + trigger-bump sequencing as handleArchiveProject above.
  const handleMoveProject = async (targetParentId: string | null) => {
    if (!selectedProjectId) return;
    const movingId = selectedProjectId;
    if (targetParentId === movingId) return; // a project can never be its own parent

    // ONE LEVEL DEEP, enforced here: a project that still has sub-projects of its
    // own (active OR archived — allProjectsForReports holds both) can never
    // become someone else's sub, because that would nest two deep, and the
    // target must be top level itself. Both halves live in the pure
    // projectMoveRefusal guard so the drawer's drag-and-drop path (U2) refuses
    // on exactly the same rule with exactly the same wording. Refused BEFORE
    // any database write, so nothing is half-applied.
    const refusal = projectMoveRefusal(movingId, targetParentId, allProjectsForReports);
    if (refusal) {
      toast.error(refusal);
      return;
    }
    const target = targetParentId ? allProjectsForReports.find(p => p.id === targetParentId) : null;

    try {
      const { error } = await supabase
        .from('focusos_projects')
        .update({ parent_project_id: targetParentId })
        .eq('id', movingId);

      if (error) throw error;

      setProjects(projects.map(p => (p.id === movingId ? { ...p, parentProjectId: targetParentId } : p)));
      setAllProjectsForReports(allProjectsForReports.map(p =>
        p.id === movingId ? { ...p, parentProjectId: targetParentId } : p
      ));

      await fetchProjects();
      setProjectRefreshTrigger(prev => prev + 1);

      toast.success(target ? `Moved under ${target.name}` : 'Moved to top level');
    } catch (error) {
      console.error('Error moving project:', error);
      toast.error('Failed to move project');
    }
  };

  // Pin / unpin (O8): the drawer floats pinned projects into their own group at
  // the top. Same local-state + fresh-refetch + trigger-bump sequencing as
  // handleMoveProject above, and the same two-toast shape, so pinning is
  // indistinguishable from every other project action once the write lands.
  const handleTogglePin = async () => {
    if (!selectedProjectId) return;
    const project = projects.find(p => p.id === selectedProjectId);
    if (!project) return;
    const nextPinnedAt = project.pinnedAt ? null : new Date().toISOString();

    // The cap counts projects and sub-projects TOGETHER, over the active list,
    // which is exactly what the drawer renders in its Pinned group. Refused
    // BEFORE any database write, so nothing is half-applied.
    if (nextPinnedAt && countPinned(projects) >= PIN_LIMIT) {
      toast.error(PIN_LIMIT_MESSAGE);
      return;
    }

    try {
      const { error } = await supabase
        .from('focusos_projects')
        .update({ pinned_at: nextPinnedAt })
        .eq('id', selectedProjectId);

      if (error) throw error;

      setProjects(projects.map(p => (p.id === selectedProjectId ? { ...p, pinnedAt: nextPinnedAt } : p)));
      setAllProjectsForReports(allProjectsForReports.map(p =>
        p.id === selectedProjectId ? { ...p, pinnedAt: nextPinnedAt } : p
      ));

      await fetchProjects();
      setProjectRefreshTrigger(prev => prev + 1);

      toast.success(nextPinnedAt ? `Pinned ${project.name}` : `Unpinned ${project.name}`);
    } catch (error) {
      console.error('Error pinning project:', error);
      toast.error('Failed to pin project');
    }
  };

  const getSelectedProjectName = (): string => {
    if (selectedSpecialList === 'today') return "Today's To-Do";
    if (selectedSpecialList === 'past-due') return "Past Due";
    if (selectedSpecialList === 'unassigned') return "Unassigned";
    if (selectedProjectId) {
      const project = projects.find(p => p.id === selectedProjectId);
      return project?.name || 'Unknown Project';
    }
    return '';
  };
  // Fuse.js instance for fuzzy search across all tasks
  const fuse = useMemo(() => new Fuse(allTasks, {
    keys: ['title', 'description'],
    threshold: 0.4, // 0 = exact, 1 = match anything
    ignoreLocation: true,
    minMatchCharLength: 2,
  }), [allTasks]);

  // `projects` is already active-only (applyProjectRows filters archived out at
  // the source) — this Set is just an O(1) membership test on top of it, reused
  // below so search/Today/Past Due exclude tasks whose project got archived
  // without re-testing archived_at anywhere.
  const activeProjectIdSet = useMemo(() => new Set(projects.map(p => p.id)), [projects]);
  const isTaskProjectActive = useCallback(
    (task: Task) => !task.projectId || activeProjectIdSet.has(task.projectId),
    [activeProjectIdSet],
  );

  const filteredTasks = useMemo(() => {
    // If searching, fuzzy search across ALL tasks (ignore project filter)
    if (searchQuery.trim().length > 0) {
      const results = fuse.search(searchQuery.trim());
      return results.map(r => r.item).filter(isTaskProjectActive);
    }

    // No search — filter by selected project or special list
    return allTasks.filter(task => {
      // Hide tasks with pending change requests in shared projects (they need to be re-accepted first)
      if (task.changeRequestMessage) return false;

      if (selectedProjectId) {
        // Roll-up scope, not a bare id match: a parent's view carries its active
        // subs' tasks too (P4).
        return isTaskInSelectedScope(task);
      } else if (selectedSpecialList === 'unassigned') {
        return !task.projectId;
      } else if (selectedSpecialList === 'today') {
        if (!task.dueDate) return false;
        if (!isTaskProjectActive(task)) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const taskDueDate = new Date(task.dueDate);
        taskDueDate.setHours(0, 0, 0, 0);
        return taskDueDate.getTime() === today.getTime();
      } else if (selectedSpecialList === 'past-due') {
        if (!task.dueDate) return false;
        if (!isTaskProjectActive(task)) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const taskDueDate = new Date(task.dueDate);
        taskDueDate.setHours(0, 0, 0, 0);
        return taskDueDate.getTime() < today.getTime();
      }
      return true;
    });
  }, [searchQuery, fuse, allTasks, selectedProjectId, selectedSpecialList, isTaskProjectActive, isTaskInSelectedScope]);

  // Priority order for sorting
  const priorityOrder = {
    'urgent': 1,
    'high': 2,
    'medium': 3,
    'low': 4
  };

  // Sort tasks by priority, then by sort_order within priority
  const sortTasksByPriority = (tasksToSort: Task[]) => {
    return [...tasksToSort].sort((a, b) => {
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
  };

  const sortedTasks = sortTasksByPriority(filteredTasks).map(t => ({
    ...t,
    sharedWithName: senderSharedMap[t.id]?.[0]?.name || undefined,
    sharedRecipients: senderSharedMap[t.id] || undefined,
  }));

  // ---- Mobile one-bar derived values. All computed DURING render from the same
  // state the desktop chrome reads, using the SAME count expressions as the
  // lg-tabs triggers — nothing is corrected after paint. ----
  const statusCounts = {
    'all': sortedTasks.filter(t => t.status !== 'completed').length,
    'todo': sortedTasks.filter(t => t.status === 'todo').length,
    'in-progress': sortedTasks.filter(t => t.status === 'in-progress').length,
    'completed': sortedTasks.filter(t => t.status === 'completed').length,
  };
  // O8, the one ordered list every project picker on this page renders: pinned
  // first (in pin order), then each sibling group in its manual sort_order, each
  // parent immediately followed by its own subs. Derived DURING RENDER from the
  // fetched rows, so the drawer, this bar's Move to... sheet and the task
  // dialog's picker can never disagree.
  const orderedProjects = useMemo(() => sortProjectsForDisplay(projects), [projects]);
  // Archived-inclusive lookup (allProjectsForReports, not the active-only
  // `projects`): once a project is archived it's no longer selectable from the
  // drawer, but it stays the SELECTED one until the user navigates away, so
  // the header must still resolve its name/color instead of falling back to
  // "All Tasks" / "Unknown Project".
  const onebarProject = selectedProjectId ? allProjectsForReports.find(p => p.id === selectedProjectId) : undefined;
  // Sub-project context, DERIVED DURING RENDER (no effect, no extra state): the
  // parent row of the selected project, its own sub-projects, and the list of
  // projects it may be moved under.
  const onebarParentProject = onebarProject?.parentProjectId
    ? allProjectsForReports.find(p => p.id === onebarProject.parentProjectId)
    : undefined;
  const onebarIsParent = !!onebarProject && !onebarProject.parentProjectId;
  const onebarHasSubProjects = !!onebarProject && allProjectsForReports.some(p => p.parentProjectId === onebarProject.id);
  // Eligible move targets: the user's OWN active TOP-LEVEL projects, never the
  // project itself and never a sub-project (one level deep).
  const onebarMoveTargets = onebarProject
    ? orderedProjects.filter(p => !p.isShared && !p.parentProjectId && p.id !== onebarProject.id)
    : [];
  const onebarSpecial = selectedSpecialList ? SPECIAL_LIST_CFG[selectedSpecialList] : undefined;
  // Same owner guard the project banner uses for its inline actions.
  const onebarIsCollaborator = (onebarProject?.isShared && onebarProject.userId !== user?.id) ?? false;
  // NOT the roll-up scope on purpose: this reads the SELECTED project's own
  // "shared by" metadata, so it must match that project exactly. A shared
  // project is rendered flat anyway (a collaborator never sees a tree).
  const onebarAssignedByEmail = onebarIsCollaborator ? allTasks.find(t => t.projectId === selectedProjectId)?.assignedToEmail : null;
  // Context title: project name (in its colour) / special-list label / the
  // all-tasks label the app already uses for the nothing-selected state.
  const onebarTitle = onebarProject ? onebarProject.name : onebarSpecial ? onebarSpecial.label : 'All Tasks';
  const OnebarIcon = onebarSpecial?.Icon;

  // O9 (2026-08-26): the desktop bar's secondary actions fold into the More
  // menu ONE AT A TIME, least-used first, as real measured width runs out —
  // see useProjectBarFold for why this is JS-measured rather than U1's single
  // fixed CSS breakpoint. Called unconditionally at the top level (Rules of
  // Hooks): `renderProjectBar` below is a plain closure, not a component, so
  // the hook cannot live inside it. Derived the same way `onebarProject`
  // above is (during render, no effect).
  const barIsArchived = !!onebarProject?.archivedAt;
  const barIsTopLevel = !onebarProject?.parentProjectId;
  // 'pin' joined the row with O8; it folds early (right after Archive), since
  // pinning is a set-once action, not a daily one.
  const BAR_FOLD_ORDER = ['delete', 'archive', 'pin', 'moveTo', 'newSub', 'share', 'meetings', 'moveTasks'];
  const barPresentKeys = new Set(['delete', 'archive', 'share', 'meetings', 'moveTasks']);
  if (!barIsArchived) barPresentKeys.add('pin');
  if (!barIsArchived) barPresentKeys.add('moveTo');
  if (barIsTopLevel && !barIsArchived) barPresentKeys.add('newSub');
  const barFoldOrderKeys = BAR_FOLD_ORDER.filter((k) => barPresentKeys.has(k));
  const barFold = useProjectBarFold(barFoldOrderKeys, {
    active: !!onebarProject && !onebarIsCollaborator,
    // Forces a re-measure on project switch even when the candidate key set
    // is unchanged (e.g. two top-level, non-archived projects) — see
    // useProjectBarFold's contentKey note: ProjectMembersBar/badges can
    // differ per project without any observed element's own box resizing.
    contentKey: onebarProject?.id,
  });

  // Project action bar — ONE implementation shared by the list and grid
  // branches (padding sweep 2026-07-26). The name never wraps: it truncates
  // with the full remaining width. DESKTOP ONLY from 2026-08-02: below lg the
  // whole bar is replaced by .lg-onebar, which relocates every action here into
  // its context sheet. The mobile Status dropdown and the mobile ⋯ menu that
  // used to live in this bar are gone — the sheet owns them now.
  const renderProjectBar = () => {
    // Same archived-inclusive lookup as onebarProject above — otherwise this
    // whole bar (name, Share, Archive/Restore, Delete) disappears the moment
    // an archived project is selected.
    const currentProject = selectedProjectId ? allProjectsForReports.find(p => p.id === selectedProjectId) : undefined;
    if (!currentProject) return null;
    const isCollaborator = (currentProject.isShared && currentProject.userId !== user?.id) ?? false;
    // Exact id match, same reason as onebarAssignedByEmail above: this project's
    // own share metadata, not a "is this task in the current view" test.
    const assignedByEmail = isCollaborator ? allTasks.find(t => t.projectId === selectedProjectId)?.assignedToEmail : null;
    // Timer glow reads the same roll-up scope as the list (P4): a timer running
    // on a SUB's task lights the parent's bar, because that task is visible in
    // this view.
    // O9 (2026-08-26): one definition per action, reused for the real bar
    // button, its hidden measurer twin (useProjectBarFold needs a real pixel
    // width for a folded action, and a folded action isn't in the live DOM to
    // measure) and its More-menu row — so the three can never drift out of
    // sync the way three hand-written copies would. Order here is DISPLAY
    // order (left to right in the bar / top to bottom in the menu); fold
    // PRIORITY order is separate (barFoldOrderKeys, computed above the return
    // for the Rules-of-Hooks reason noted there) — least-used first: Delete,
    // Archive, Move to..., New sub-project, Share, Meetings, Move Tasks last.
    const barItems: Array<{
      key: string;
      icon: JSX.Element;
      label: string;
      onClick: () => void;
      variant?: 'ghost' | 'secondary';
      className: string;
      spanClassName?: string;
      testId?: string;
      moreTestId: string;
      destructive?: boolean;
    }> = [
      {
        key: 'moveTasks',
        icon: <ArrowUpDown className="h-4 w-4" />,
        label: isReorderMode ? 'Done Moving' : 'Move Tasks',
        onClick: () => setIsReorderMode(!isReorderMode),
        variant: isReorderMode ? 'secondary' : 'ghost',
        className: 'gap-1',
        moreTestId: 'desktop-more-move-tasks',
      },
      {
        key: 'meetings',
        icon: <Mic className="h-4 w-4" />,
        label: 'Meetings',
        onClick: () => navigate(`/meetings?project=${selectedProjectId}`),
        className: 'gap-1',
        moreTestId: 'desktop-more-meetings',
      },
      {
        key: 'share',
        icon: <Share2 className="h-4 w-4" />,
        label: 'Share',
        onClick: () => setShareProjectDialogOpen(true),
        className: 'gap-1 text-primary hover:text-primary/80 hover:bg-primary/10',
        moreTestId: 'desktop-more-share',
      },
      // "New sub-project" only on a TOP-LEVEL project; hidden while archived.
      ...(!currentProject.parentProjectId && !currentProject.archivedAt ? [{
        key: 'newSub',
        icon: <FolderPlus className="h-4 w-4" />,
        label: 'New sub-project',
        onClick: () => openNewSubProjectDialog(currentProject.id),
        className: 'gap-1',
        testId: 'desktop-new-sub',
        moreTestId: 'desktop-more-new-sub',
      }] : []),
      // Pin (O8): same ghost/sm/gap-1 action as its siblings, no new visual.
      // Hidden while archived, exactly like Move to..., because archiving
      // clears the pin.
      ...(!currentProject.archivedAt ? [{
        key: 'pin',
        icon: currentProject.pinnedAt ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />,
        label: currentProject.pinnedAt ? 'Unpin' : 'Pin',
        onClick: handleTogglePin,
        className: 'gap-1',
        testId: 'desktop-pin',
        moreTestId: 'desktop-more-pin',
      }] : []),
      ...(!currentProject.archivedAt ? [{
        key: 'moveTo',
        icon: <FolderKanban className="h-4 w-4" />,
        label: 'Move to...',
        onClick: () => setOnebarSheet('move'),
        className: 'gap-1',
        testId: 'desktop-move',
        moreTestId: 'desktop-more-move',
      }] : []),
      currentProject.archivedAt ? {
        key: 'archive',
        icon: <ArchiveRestore className="h-4 w-4" />,
        label: 'Restore',
        onClick: handleRestoreProject,
        className: 'gap-1',
        testId: 'desktop-restore',
        moreTestId: 'desktop-more-restore',
      } : {
        key: 'archive',
        icon: <Archive className="h-4 w-4" />,
        label: 'Archive',
        onClick: () => setArchiveConfirmOpen(true),
        className: 'gap-1',
        testId: 'desktop-archive',
        moreTestId: 'desktop-more-archive',
      },
      {
        key: 'delete',
        icon: <Trash2 className="h-4 w-4" />,
        label: 'Delete',
        onClick: () => setDeleteConfirmOpen(true),
        className: 'text-destructive hover:text-destructive hover:bg-destructive/10',
        spanClassName: 'ml-1',
        destructive: true,
        moreTestId: 'desktop-more-delete',
      },
    ];
    const { rowRef, nameGroupRef, nameRef, measureRef, foldedKeys, hasFolded } = barFold;
    const visibleItems = barItems.filter((item) => !foldedKeys.has(item.key));
    const foldedItems = barItems.filter((item) => foldedKeys.has(item.key));

    return (
      <div className={`hidden lg:block w-full shrink-0 lg-projbar ${allTasks.some(t => isTaskInSelectedScope(t) && t.timer.isRunning) ? 'border-glow-pulse' : ''}`}>
        <div ref={rowRef} className="relative flex items-center justify-between gap-1 sm:gap-2 px-2 sm:px-3 py-2">
          <div ref={nameGroupRef} className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0">
            <span className="hidden sm:inline shrink-0" style={{ color: currentProject.color }}>📁</span>

            {/* Sub-project breadcrumb, same derivation as the one-bar's
                (onebarParentProject) — the desktop banner is the header at lg+. */}
            {onebarParentProject && (
              <span className="flex items-center gap-1 shrink-0 min-w-0 max-w-[35%] text-sm text-muted-foreground">
                <span className="truncate min-w-0" data-testid="desktop-parent-name">{onebarParentProject.name}</span>
                <span className="opacity-60">/</span>
              </span>
            )}

            {isEditingProjectName && !isCollaborator ? (
              <Input
                // O9 skeptic fix (2026-08-26): the fold hook's name ref must
                // follow the name into its rename form. With the ref only on
                // the display span, entering rename unmounted the observed
                // node, the layout effect bailed on its null check and the
                // ResizeObserver stayed disconnected, freezing the fold for
                // the whole edit — a resize mid-rename clipped the action
                // cluster ~137px past the bar edge (skeptic repro, 1500 to
                // 1024). The hook only uses this node to exclude the flexible
                // name from the fixed-sibling sum, so the input serves the
                // same role.
                ref={nameRef}
                autoFocus
                value={editedProjectName}
                onChange={(e) => setEditedProjectName(e.target.value)}
                onBlur={handleSaveProjectName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveProjectName();
                  if (e.key === 'Escape') setIsEditingProjectName(false);
                }}
                className="font-semibold text-base h-auto py-1 px-2 flex-1 min-w-0"
                style={{ color: currentProject.color }}
              />
            ) : (
              <span
                ref={nameRef}
                className={`font-semibold text-base truncate min-w-[4rem] ${!isCollaborator ? 'cursor-pointer hover:opacity-70' : ''} transition-opacity`}
                style={{ color: currentProject.color }}
                onClick={!isCollaborator ? handleStartEditingProject : undefined}
                data-projects-tour-step="project-name"
                title={currentProject.name}
              >
                {currentProject.name}
              </span>
            )}
            {currentProject.archivedAt && (
              <Badge
                variant="outline"
                data-testid="project-archived-badge"
                className="bg-muted-foreground/10 text-muted-foreground border-muted-foreground/30 text-xs inline-flex items-center gap-1 shrink-0"
              >
                Archived
              </Badge>
            )}
            {isCollaborator && assignedByEmail && (
              <Badge variant="outline" className="bg-purple-600/15 text-purple-400 border-purple-600/30 text-xs inline-flex items-center gap-1 shrink-0 max-w-[45%]">
                <Share2 className="h-3 w-3 shrink-0" />
                <span className="truncate">Shared by {assignerNameMap[assignedByEmail] || assignedByEmail}</span>
              </Badge>
            )}
            {!isCollaborator && selectedProjectId && senderProjectSharedMap[selectedProjectId] && (
              <span className="shrink-0">
                <ShareStatusPopover recipients={senderProjectSharedMap[selectedProjectId]} itemType="Project" />
              </span>
            )}
            {!isCollaborator && selectedProjectId && (
              <div className="hidden lg:block shrink-0">
                <ProjectMembersBar
                  projectId={selectedProjectId}
                  isOwner={!isCollaborator}
                  onInviteClick={() => setInviteDialogOpen(true)}
                  refreshTrigger={memberRefreshTrigger}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {!isCollaborator && (
              <>
                {/* Progressive fold (O9, 2026-08-26): each visible item here is
                    exactly `barItems` minus whatever useProjectBarFold measured
                    as not fitting — no CSS breakpoint, no post-paint fixup. */}
                {visibleItems.map((item) => (
                  <Button
                    key={item.key}
                    variant={item.variant ?? 'ghost'}
                    size="sm"
                    className={item.className}
                    data-testid={item.testId}
                    data-projects-tour-step={item.key === 'delete' ? 'delete-button' : undefined}
                    onClick={item.onClick}
                  >
                    {item.icon}
                    <span className={item.spanClassName}>{item.label}</span>
                  </Button>
                ))}

                {/* Hidden measurer (position:absolute, visibility:hidden — takes
                    real layout width but paints nothing and never receives
                    input): the ONLY way to know a folded item's pixel width,
                    since a folded item isn't rendered in the row above to
                    measure directly. Same classes as the real buttons so the
                    width matches to the pixel. Always renders every candidate,
                    regardless of current fold state. */}
                <div
                  ref={measureRef}
                  aria-hidden="true"
                  style={{ position: 'absolute', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none', height: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  {barItems.map((item) => (
                    <Button
                      key={item.key}
                      data-fold-key={item.key}
                      tabIndex={-1}
                      variant={item.variant ?? 'ghost'}
                      size="sm"
                      className={item.className}
                    >
                      {item.icon}
                      <span className={item.spanClassName}>{item.label}</span>
                    </Button>
                  ))}
                  <Button data-fold-more tabIndex={-1} variant="ghost" size="sm" aria-label="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>

                {/* The More trigger only exists once something is folded, and
                    whenever it exists Delete is guaranteed to be among the
                    folded items (Delete folds first in barFoldOrderKeys), so
                    the trigger is always the right element to carry the
                    projects-tour delete anchor while it's up — same reason the
                    mobile one-bar title wrapper does (U1, 2026-08-23; skeptic
                    finding c558658). Because folding here is real React
                    mount/unmount (not a CSS display swap), the existing
                    MutationObserver in useTourSpotlight already re-resolves the
                    target on this change; 92d40c5's resize-triggered
                    re-resolve still runs too, belt and braces. */}
                {hasFolded && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label="More actions" data-testid="desktop-more" data-projects-tour-step="delete-button">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48 bg-popover">
                      {foldedItems.map((item) => (
                        <DropdownMenuItem
                          key={item.key}
                          data-testid={item.moreTestId}
                          className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
                          onClick={item.onClick}
                        >
                          {item.icon}
                          <span className="ml-2">{item.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Show loading screen while auth is resolving
  if (authLoading) {
    return <AppBootSkeleton />;
  }
  
  // Auth resolved but no user — show spinner while useEffect redirects
  if (!user) {
    return <AppBootSkeleton />;
  }

  // User exists but preferences still loading — keep full-screen spinner until
  // preferences resolve (default_view drives initial view selection). Once
  // preferences exist, render the shell immediately and skeleton the task area
  // while initialLoadComplete is still false.
  if (prefsLoading || !preferences) {
    return <AppBootSkeleton />;
  }

  // Is a DOCKED Add/Edit pane on screen? Mirrors the exact render condition of
  // the desktop panel below, so the two can never disagree. The pane is
  // position:fixed glass (.liquid-glass [data-side-panel] in src/index.css), so
  // it takes no space in this flex row and would float OVER the task list —
  // .lg-pane-open is how the content column reserves its width instead.
  // Derived DURING RENDER from the same state that renders the pane: the
  // reservation and the pane land in the same commit, never a post-paint effect.
  const dockedPaneOpen = !isMobile && (!!editingTask || addTaskDialogOpen);

  return <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <MobileSidebarController tourStep={lastProcessedTourStep} isTourActive={showProjectsTour} currentTourStep={projectsTourCurrentStep} openSidebarRequested={openSidebarRequested} onOpenSidebarHandled={handleOpenSidebarHandled} />
      <div className="h-screen flex w-full relative overflow-hidden lg-shell">
        <div className="flex flex-1 relative w-full flex-col min-h-0">
          <div className="flex flex-1 relative min-h-0">
            {/* Sidebar */}
            <ProjectSidebar selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId} onSelectSpecialList={setSelectedSpecialList} selectedSpecialList={selectedSpecialList} projectRefreshTrigger={projectRefreshTrigger} onProjectCreated={() => { setProjectRefreshTrigger(prev => prev + 1); fetchTasks(); }} onStartTour={handleHelpClick} onStartTaskTour={handleStartTaskTour} onStartProjectsTour={handleStartProjectsTour} createDialogOpen={showProjectsTour ? tourCreateDialogOpen : (newSubParentId ? true : undefined)} onCreateDialogOpenChange={showProjectsTour ? setTourCreateDialogOpen : (newSubParentId ? ((open: boolean) => { if (!open) setNewSubParentId(null); }) : undefined)} createParentProjectId={newSubParentId} isTourActive={showProjectsTour} userId={user?.id} senderProjectSharedMap={senderProjectSharedMap} sharedItemsRefreshTrigger={sharedItemsRefreshTrigger} onSenderSharedItemsChanged={fetchSenderSharedItems} />

            {/* Main Content */}
            <div className="flex-1 relative z-10 min-w-0 flex flex-col min-h-0 overflow-x-hidden">
              <div className={`flex flex-col flex-1 min-h-0 w-full lg-maincol${dockedPaneOpen ? ' lg-pane-open' : ''}`}>

          {/* Actions Bar — mock .pw-row1: search + view seg + density seg + Add Task.
              DESKTOP ONLY (≥lg); below lg .lg-onebar below replaces it. */}
          <div className="hidden lg:flex flex-row gap-2 items-center shrink-0 lg-row1">
            <div className="lg-search relative flex-1">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <input placeholder="Search tasks…" value={searchInput} onChange={e => setSearchInput(e.target.value)} />
            </div>
            <div className="lg-seg">
              <button type="button" className={viewMode === 'list' ? 'on' : ''} onClick={() => setViewMode('list')}>
                <LayoutList className="h-[13px] w-[13px]" /><span>List</span>
              </button>
              <button type="button" className={viewMode === 'grid' ? 'on' : ''} onClick={() => setViewMode('grid')}>
                <LayoutGrid className="h-[13px] w-[13px]" /><span>Grid</span>
              </button>
              <button type="button" className={viewMode === 'gantt' ? 'on' : ''} onClick={() => setViewMode('gantt')}>
                <GanttChartSquare className="h-[13px] w-[13px]" /><span>Gantt</span>
              </button>
              <button type="button" className={viewMode === 'time-tracking' ? 'on' : ''} onClick={() => setViewMode('time-tracking')}>
                <Clock className="h-[13px] w-[13px]" /><span>Time</span>
              </button>
            </div>
            {viewMode === 'list' && (
              <div className="lg-seg lg-density">
                <button type="button" className={globalCardView === 'full' ? 'on' : ''} onClick={() => { setGlobalCardView('full'); setExpandedTaskIds(new Set()); }}>
                  <span>Full</span>
                </button>
                <button type="button" className={globalCardView === 'compact' ? 'on' : ''} onClick={() => { setGlobalCardView('compact'); setExpandedTaskIds(new Set()); }}>
                  <span>Compact</span>
                </button>
                <button type="button" className={globalCardView === 'minimal' ? 'on' : ''} onClick={() => { setGlobalCardView('minimal'); setExpandedTaskIds(new Set()); }}>
                  <span>Minimal</span>
                </button>
              </div>
            )}
            <button
              type="button"
              aria-label="Add task"
              className="lg-btn acc shrink-0"
              data-task-tour-step="add-task-button"
              onClick={() => handleAddTaskDialogOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Add Task</span>
            </button>
          </div>

          {/* ================= MOBILE ONE-BAR (<lg) =================
              ONE glass bar replacing the three stacked bars (lg-row1, lg-tabs,
              the project/special banner) below the lg breakpoint. Four slots:
              context title -> context sheet (view / density / this context's
              actions), status pill -> status sheet, search, Add. Every value it
              shows is derived during render from the same state the desktop
              chrome reads; the bar owns no defaults and no persistence. */}
          <div className="lg:hidden flex items-center gap-1.5 shrink-0 lg-onebar" data-testid="onebar">
            {onebarSearchOpen ? (
              <>
                <div className="lg-onebar-field flex-1 min-w-0">
                  <Search className="h-4 w-4 shrink-0" />
                  <input
                    ref={onebarSearchRef}
                    data-testid="onebar-search-field"
                    aria-label="Search tasks"
                    placeholder="Search tasks…"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="lg-onebar-cancel"
                  data-testid="onebar-search-cancel"
                  onClick={closeOnebarSearch}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {/* Slot 1 — context title. The wrapper carries the projects-tour
                    delete anchor because the sheet behind this chip is where
                    Delete Project lives on mobile now; the chip itself carries
                    the rename anchor. Desktop keeps its own anchors on the
                    banner, and the tour spotlight picks the first VISIBLE match. */}
                <div
                  className="flex-1 min-w-0"
                  {...(onebarProject && !onebarIsCollaborator ? { 'data-projects-tour-step': 'delete-button' } : {})}
                >
                  <button
                    type="button"
                    className="lg-onebar-title"
                    data-testid="onebar-title"
                    aria-label={`${onebarTitle} — view, density and actions`}
                    onClick={() => setOnebarSheet('context')}
                    {...(onebarProject ? { 'data-projects-tour-step': 'project-name' } : {})}
                  >
                    {OnebarIcon && <OnebarIcon className={`h-4 w-4 shrink-0 ${onebarSpecial.color}`} />}
                    {/* Sub-project breadcrumb: the parent's name ahead of the
                        project's own, derived during render from
                        allProjectsForReports so an archived parent still
                        resolves. Capped so a long parent name can never crowd
                        out the project it is labelling. */}
                    {onebarParentProject && (
                      <>
                        <span
                          className="truncate min-w-0 max-w-[40%] text-xs opacity-70"
                          data-testid="onebar-parent-name"
                        >
                          {onebarParentProject.name}
                        </span>
                        <span className="shrink-0 text-xs opacity-50">/</span>
                      </>
                    )}
                    <span
                      className={`truncate min-w-0 ${onebarSpecial ? onebarSpecial.color : ''}`}
                      style={onebarProject ? { color: onebarProject.color } : undefined}
                    >
                      {onebarTitle}
                    </span>
                    {onebarProject?.archivedAt && (
                      <Badge
                        variant="outline"
                        data-testid="onebar-archived-badge"
                        className="bg-muted-foreground/10 text-muted-foreground border-muted-foreground/30 text-[10px] leading-none px-1.5 py-0.5 inline-flex items-center gap-1 shrink-0"
                      >
                        Archived
                      </Badge>
                    )}
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  </button>
                </div>

                {/* Slot 2 — status pill. Same count expressions as lg-tabs. */}
                <div className="lg-onebar-pill" data-testid="onebar-status">
                  <button
                    type="button"
                    className="lg-onebar-pill-main"
                    data-testid="onebar-status-open"
                    onClick={() => setOnebarSheet('status')}
                  >
                    {STATUS_LABELS[activeTab]} · {statusCounts[activeTab]}
                  </button>
                  {activeTab !== 'all' && (
                    <button
                      type="button"
                      className="lg-onebar-pill-x"
                      aria-label="Clear status filter"
                      data-testid="onebar-status-clear"
                      onClick={() => setActiveTab('all')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* Slot 3 — search. Collapsed it shows a dot whenever a live
                    filter is running, so the filter is never invisible. */}
                <button
                  type="button"
                  className="lg-onebar-icon"
                  aria-label="Search tasks"
                  data-testid="onebar-search-btn"
                  onClick={openOnebarSearch}
                >
                  <Search className="h-4 w-4" />
                  {searchInput.length > 0 && <span className="lg-onebar-dot" data-testid="onebar-search-active" />}
                </button>

                {/* Slot 4 — Add. Carries the task-tour anchor below lg, where the
                    lg-row1 Add button is hidden. */}
                <button
                  type="button"
                  aria-label="Add task"
                  className="lg-btn acc lg-onebar-add"
                  data-testid="onebar-add"
                  data-task-tour-step="add-task-button"
                  onClick={() => handleAddTaskDialogOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </>
            )}
          </div>

          {/* Context sheet — view, density and every action the desktop banner
              offers for the current context. Plain open-on-tap Radix Sheet: NOT
              forceMount, so it is unmounted while closed (drawer law) and the
              only animation is the Sheet's own house slide. TOUCH-SAFE (O6 fix round,
              2026-08-23): this is the ONE one-bar sheet that holds a text field
              ("Rename project" below), and on the iOS 26.3 sim the modal Sheet's
              react-remove-scroll killed the selection-handle drag in it exactly
              as it did in the Edit Task dialog ([3,10] -> [3,10]). TouchSheet is
              the same cure as TouchDialog; the move and status sheets hold no
              field and stay stock. */}
          <TouchSheet open={onebarSheet === 'context'} onOpenChange={(o) => { if (!o) setOnebarSheet(null); }}>
            <TouchSheetContent side="bottom" className="lg-onebar-sheet" data-testid="onebar-context-sheet" aria-describedby={undefined}>
              <SheetHeader>
                <SheetTitle className="truncate pr-8" style={onebarProject ? { color: onebarProject.color } : undefined}>
                  {onebarTitle}
                </SheetTitle>
              </SheetHeader>

              {onebarIsCollaborator && onebarAssignedByEmail && (
                <Badge variant="outline" className="bg-purple-600/15 text-purple-400 border-purple-600/30 text-xs inline-flex items-center gap-1 self-start max-w-full">
                  <Share2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">Shared by {assignerNameMap[onebarAssignedByEmail] || onebarAssignedByEmail}</span>
                </Badge>
              )}
              {onebarProject && !onebarIsCollaborator && senderProjectSharedMap[onebarProject.id] && (
                <div className="self-start">
                  <ShareStatusPopover recipients={senderProjectSharedMap[onebarProject.id]} itemType="Project" />
                </div>
              )}

              <div className="lg-onebar-sec">
                <div className="lg-onebar-lbl">View</div>
                {([
                  { v: 'list', Icon: LayoutList, label: 'List' },
                  { v: 'grid', Icon: LayoutGrid, label: 'Grid' },
                  { v: 'gantt', Icon: GanttChartSquare, label: 'Gantt' },
                  { v: 'time-tracking', Icon: Clock, label: 'Time' },
                ] as const).map(({ v, Icon, label }) => (
                  <button
                    key={v}
                    type="button"
                    className="lg-onebar-row"
                    data-testid={`onebar-view-${v}`}
                    onClick={() => { setViewMode(v); setOnebarSheet(null); }}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">{label}</span>
                    {viewMode === v && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                ))}
              </div>

              {/* Density — SAME condition as the desktop lg-density seg. */}
              {viewMode === 'list' && (
                <div className="lg-onebar-sec" data-testid="onebar-density-section">
                  <div className="lg-onebar-lbl">Density</div>
                  {([
                    { d: 'full', label: 'Full' },
                    { d: 'compact', label: 'Compact' },
                    { d: 'minimal', label: 'Minimal' },
                  ] as const).map(({ d, label }) => (
                    <button
                      key={d}
                      type="button"
                      className="lg-onebar-row"
                      data-testid={`onebar-density-${d}`}
                      onClick={() => { setGlobalCardView(d); setExpandedTaskIds(new Set()); setOnebarSheet(null); }}
                    >
                      <span className="flex-1 text-left">{label}</span>
                      {globalCardView === d && <Check className="h-4 w-4 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}

              {/* Project actions — every button the desktop banner and the old
                  mobile ⋯ menu offered, same owner guard. */}
              {onebarProject && !onebarIsCollaborator && (
                <div className="lg-onebar-sec" data-testid="onebar-actions-section">
                  <div className="lg-onebar-lbl">Project</div>
                  {isEditingProjectName ? (
                    <div className="flex items-center gap-2">
                      <Input
                        autoFocus
                        data-testid="onebar-rename-input"
                        value={editedProjectName}
                        onChange={(e) => setEditedProjectName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveProjectName();
                          if (e.key === 'Escape') setIsEditingProjectName(false);
                        }}
                        className="flex-1 min-w-0"
                      />
                      <button type="button" className="lg-btn acc shrink-0" data-testid="onebar-rename-save" onClick={handleSaveProjectName}>
                        Save
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="lg-onebar-row" data-testid="onebar-rename" onClick={handleStartEditingProject}>
                      <Pencil className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Rename project</span>
                    </button>
                  )}
                  <button type="button" className="lg-onebar-row" data-testid="onebar-reorder" onClick={() => { setIsReorderMode(!isReorderMode); setOnebarSheet(null); }}>
                    <ArrowUpDown className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">{isReorderMode ? 'Done Moving' : 'Move Tasks'}</span>
                  </button>
                  <button type="button" className="lg-onebar-row" data-testid="onebar-meetings" onClick={() => { setOnebarSheet(null); navigate(`/meetings?project=${selectedProjectId}`); }}>
                    <Mic className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">Meetings</span>
                  </button>
                  <button type="button" className="lg-onebar-row" data-testid="onebar-invite" onClick={() => { setOnebarSheet(null); setInviteDialogOpen(true); }}>
                    <UserPlus className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">Invite Member</span>
                  </button>
                  <button type="button" className="lg-onebar-row" data-testid="onebar-share" onClick={() => { setOnebarSheet(null); setShareProjectDialogOpen(true); }}>
                    <Share2 className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">Share</span>
                  </button>
                  {/* Sub-projects (P3). "New sub-project" only where a sub can
                      legally live — under a TOP-LEVEL project — and only while
                      the project is active. "Move to…" opens its own sheet. */}
                  {onebarIsParent && !onebarProject?.archivedAt && (
                    <button
                      type="button"
                      className="lg-onebar-row"
                      data-testid="onebar-new-sub"
                      onClick={() => { setOnebarSheet(null); openNewSubProjectDialog(onebarProject!.id); }}
                    >
                      <FolderPlus className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">New sub-project</span>
                    </button>
                  )}
                  {/* Pin (O8): the same lg-onebar-row every other action in
                      this sheet uses. The 5-pin cap refuses the sixth with a
                      toast; nothing about this row changes while it is at the cap
                      (the refusal has to be readable, not silent). */}
                  {!onebarProject?.archivedAt && (
                    <button
                      type="button"
                      className="lg-onebar-row"
                      data-testid="onebar-pin"
                      onClick={() => { setOnebarSheet(null); handleTogglePin(); }}
                    >
                      {onebarProject?.pinnedAt ? <PinOff className="h-4 w-4 shrink-0" /> : <Pin className="h-4 w-4 shrink-0" />}
                      <span className="flex-1 text-left">{onebarProject?.pinnedAt ? 'Unpin Project' : 'Pin Project'}</span>
                    </button>
                  )}
                  {!onebarProject?.archivedAt && (
                    <button
                      type="button"
                      className="lg-onebar-row"
                      data-testid="onebar-move"
                      onClick={() => setOnebarSheet('move')}
                    >
                      <FolderKanban className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Move to...</span>
                    </button>
                  )}
                  {onebarProject?.archivedAt ? (
                    <button type="button" className="lg-onebar-row" data-testid="onebar-restore" onClick={() => { setOnebarSheet(null); handleRestoreProject(); }}>
                      <ArchiveRestore className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Restore Project</span>
                    </button>
                  ) : (
                    <button type="button" className="lg-onebar-row" data-testid="onebar-archive" onClick={() => { setOnebarSheet(null); setArchiveConfirmOpen(true); }}>
                      <Archive className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Archive Project</span>
                    </button>
                  )}
                  <button type="button" className="lg-onebar-row lg-onebar-row-danger" data-testid="onebar-delete" onClick={() => { setOnebarSheet(null); setDeleteConfirmOpen(true); }}>
                    <Trash2 className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">Delete Project</span>
                  </button>
                </div>
              )}

              {/* Special-list actions — Move Tasks always, Share where the
                  desktop banner offers it (cfg.share). */}
              {onebarSpecial && (
                <div className="lg-onebar-sec" data-testid="onebar-actions-section">
                  <div className="lg-onebar-lbl">List</div>
                  <button type="button" className="lg-onebar-row" data-testid="onebar-reorder" onClick={() => { setIsReorderMode(!isReorderMode); setOnebarSheet(null); }}>
                    <ArrowUpDown className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">{isReorderMode ? 'Done Moving' : 'Move Tasks'}</span>
                  </button>
                  {onebarSpecial.share && (
                    <button type="button" className="lg-onebar-row" data-testid="onebar-share" onClick={() => { setOnebarSheet(null); setShareProjectDialogOpen(true); }}>
                      <Share2 className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Share</span>
                    </button>
                  )}
                </div>
              )}
            </TouchSheetContent>
          </TouchSheet>

          {/* Move-to sheet (P3) — the SAME plain open-on-tap Radix Sheet +
              lg-onebar-row list the context sheet uses, so nothing new was
              invented for it. Targets are the user's own active TOP-LEVEL
              projects; a sub-project is never offered, which is half of the
              one-level rule. The other half (a project that HAS subs cannot
              become a sub) is enforced in handleMoveProject, which refuses with
              a toast before any database write. */}
          <Sheet open={onebarSheet === 'move'} onOpenChange={(o) => { if (!o) setOnebarSheet(null); }}>
            <SheetContent side="bottom" className="lg-onebar-sheet" data-testid="onebar-move-sheet" aria-describedby={undefined}>
              <SheetHeader>
                <SheetTitle className="truncate pr-8">Move to...</SheetTitle>
              </SheetHeader>
              <div className="lg-onebar-sec">
                {onebarHasSubProjects && (
                  <div className="lg-onebar-lbl" data-testid="onebar-move-has-subs-note">
                    This project has sub-projects, so it can only sit at top level.
                  </div>
                )}
                <button
                  type="button"
                  className="lg-onebar-row"
                  data-testid="onebar-move-top"
                  onClick={() => { setOnebarSheet(null); handleMoveProject(null); }}
                >
                  <span className="flex-1 text-left">Top level (no parent)</span>
                  {!onebarProject?.parentProjectId && <Check className="h-4 w-4 shrink-0" />}
                </button>
                {onebarMoveTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className="lg-onebar-row"
                    data-testid={`onebar-move-to-${target.id}`}
                    onClick={() => { setOnebarSheet(null); handleMoveProject(target.id); }}
                  >
                    <Folder className="h-4 w-4 shrink-0" style={{ color: target.color }} />
                    <span className="flex-1 text-left truncate">{target.name}</span>
                    {onebarProject?.parentProjectId === target.id && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                ))}
              </div>
            </SheetContent>
          </Sheet>

          {/* Status sheet — the four lg-tabs filters with their live counts. */}
          <Sheet open={onebarSheet === 'status'} onOpenChange={(o) => { if (!o) setOnebarSheet(null); }}>
            <SheetContent side="bottom" className="lg-onebar-sheet" data-testid="onebar-status-sheet" aria-describedby={undefined}>
              <SheetHeader>
                <SheetTitle>Status</SheetTitle>
              </SheetHeader>
              <div className="lg-onebar-sec">
                {STATUS_ORDER.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="lg-onebar-row"
                    data-testid={`onebar-status-${s}`}
                    onClick={() => { setActiveTab(s); setOnebarSheet(null); }}
                  >
                    <span className="flex-1 text-left">{STATUS_LABELS[s]} ({statusCounts[s]})</span>
                    {activeTab === s && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                ))}
              </div>
            </SheetContent>
          </Sheet>

          {/* Main Content */}
          {loadFailed ? <LoadErrorPanel onRetry={handleRetryLoad} /> : !fullDataLoaded || !preferencesLoaded ? <TaskListSkeleton /> : viewMode === 'list' ? <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as any)} className="w-full flex flex-col flex-1 min-h-0 gap-2.5">
              <TabsList className="hidden lg:grid w-full grid-cols-4 h-auto shrink-0 lg-tabs">
                <TabsTrigger value="all" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  All ({sortedTasks.filter(t => t.status !== 'completed').length})
                </TabsTrigger>
                <TabsTrigger value="todo" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  To Do ({sortedTasks.filter(t => t.status === 'todo').length})
                </TabsTrigger>
                <TabsTrigger value="in-progress" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  Progress ({sortedTasks.filter(t => t.status === 'in-progress').length})
                </TabsTrigger>
                <TabsTrigger value="completed" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  Done ({sortedTasks.filter(t => t.status === 'completed').length})
                </TabsTrigger>
              </TabsList>

              {renderProjectBar()}

              {/* Special-view banner (Today / Past Due / Unassigned) — same glass
                  pill as the project banner (lg-projbar), identity carried by
                  icon + text colour, never by a background tint. DESKTOP ONLY
                  from 2026-08-02: below lg .lg-onebar carries the label and
                  relocates Move Tasks + Share into its context sheet. */}
              {selectedSpecialList && (() => {
                const cfg = SPECIAL_LIST_CFG[selectedSpecialList];
                if (!cfg) return null;
                const SpecialIcon = cfg.Icon;
                return (
                  <div className="hidden lg:block w-full shrink-0 lg-projbar">
                    <div className="flex items-center justify-between gap-1 sm:gap-2 px-2 sm:px-3 py-2">
                      <div className="flex items-center gap-2 flex-1">
                        <SpecialIcon className={`h-5 w-5 ${cfg.color}`} />
                        <span className={`font-semibold text-base ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          variant={isReorderMode ? "default" : "outline"}
                          size="sm"
                          onClick={() => setIsReorderMode(!isReorderMode)}
                          className="gap-1"
                        >
                          <ArrowUpDown className="h-4 w-4" />
                          <span className="hidden lg:inline">{isReorderMode ? 'Done Moving' : 'Move Tasks'}</span>
                          <span className="lg:hidden">{isReorderMode ? 'Done' : 'Move'}</span>
                        </Button>

                        {cfg.share && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-primary hover:text-primary/80 hover:bg-primary/10"
                            onClick={() => setShareProjectDialogOpen(true)}
                          >
                            <Share2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              <TabsContent value="all" className="flex-initial min-h-0 lg-content">
                <DraggableTaskList
                  tasks={sortedTasks.filter(t => t.status !== 'completed')}
                  onUpdate={handleUpdateTask}
                  onBatchUpdate={handleBatchUpdateTasks}
                  onEditTask={setEditingTask}
                  onEditTaskImages={handleEditTaskImages}
                  onEditTaskDates={handleEditTaskDates}
                  onAssignTask={handleAssignTask}
                  onRequestChanges={handleRequestChanges}
                  onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask}
                  globalViewMode={globalCardView}
                  expandedTaskIds={expandedTaskIds}
                  onTaskClick={handleTaskClick}
                  projects={projects}
                  getScopeLabel={scopeLabelFor}
                  isReorderMode={isReorderMode}
                />
              </TabsContent>

              <TabsContent value="todo" className="flex-initial min-h-0 lg-content">
                <DraggableTaskList
                  tasks={sortedTasks.filter(t => t.status === 'todo')}
                  onUpdate={handleUpdateTask}
                  onBatchUpdate={handleBatchUpdateTasks}
                  onEditTask={setEditingTask}
                  onEditTaskImages={handleEditTaskImages}
                  onEditTaskDates={handleEditTaskDates}
                  onAssignTask={handleAssignTask}
                  onRequestChanges={handleRequestChanges}
                  onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask}
                  globalViewMode={globalCardView}
                  expandedTaskIds={expandedTaskIds}
                  onTaskClick={handleTaskClick}
                  projects={projects}
                  getScopeLabel={scopeLabelFor}
                  isReorderMode={isReorderMode}
                />
              </TabsContent>

              <TabsContent value="in-progress" className="flex-initial min-h-0 lg-content">
                <DraggableTaskList
                  tasks={sortedTasks.filter(t => t.status === 'in-progress')}
                  onUpdate={handleUpdateTask}
                  onBatchUpdate={handleBatchUpdateTasks}
                  onEditTask={setEditingTask}
                  onEditTaskImages={handleEditTaskImages}
                  onEditTaskDates={handleEditTaskDates}
                  onAssignTask={handleAssignTask}
                  onRequestChanges={handleRequestChanges}
                  onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask}
                  globalViewMode={globalCardView}
                  expandedTaskIds={expandedTaskIds}
                  onTaskClick={handleTaskClick}
                  projects={projects}
                  getScopeLabel={scopeLabelFor}
                  isReorderMode={isReorderMode}
                />
              </TabsContent>

              <TabsContent value="completed" className="flex-initial min-h-0 lg-content">
                <DraggableTaskList
                  tasks={sortedTasks.filter(t => t.status === 'completed')}
                  onUpdate={handleUpdateTask}
                  onBatchUpdate={handleBatchUpdateTasks}
                  onEditTask={setEditingTask}
                  onEditTaskImages={handleEditTaskImages}
                  onEditTaskDates={handleEditTaskDates}
                  onAssignTask={handleAssignTask}
                  onRequestChanges={handleRequestChanges}
                  onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask}
                  globalViewMode={globalCardView}
                  expandedTaskIds={expandedTaskIds}
                  onTaskClick={handleTaskClick}
                  projects={projects}
                  getScopeLabel={scopeLabelFor}
                  isReorderMode={isReorderMode}
                />
              </TabsContent>
            </Tabs> : viewMode === 'grid' ? <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as any)} className="w-full flex flex-col flex-1 min-h-0 gap-2.5">
              <TabsList className="hidden lg:grid w-full grid-cols-4 h-auto shrink-0 lg-tabs">
                <TabsTrigger value="all" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  All ({sortedTasks.filter(t => t.status !== 'completed').length})
                </TabsTrigger>
                <TabsTrigger value="todo" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  To Do ({sortedTasks.filter(t => t.status === 'todo').length})
                </TabsTrigger>
                <TabsTrigger value="in-progress" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  Progress ({sortedTasks.filter(t => t.status === 'in-progress').length})
                </TabsTrigger>
                <TabsTrigger value="completed" className="text-xs sm:text-sm py-2 sm:py-1.5">
                  Done ({sortedTasks.filter(t => t.status === 'completed').length})
                </TabsTrigger>
              </TabsList>

              {renderProjectBar()}

              <TabsContent value="all" className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 content-start flex-initial min-h-0 lg-content">
                {sortedTasks.filter(t => t.status !== 'completed').map(task => <TaskCard key={task.id} task={task} onUpdate={handleUpdateTask} onEditTask={setEditingTask} onAssignTask={handleAssignTask} onRequestChanges={handleRequestChanges} onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask} projects={projects} scopeLabel={scopeLabelFor(task)} />)}
              </TabsContent>

              <TabsContent value="todo" className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 content-start flex-initial min-h-0 lg-content">
                {sortedTasks.filter(t => t.status === 'todo').map(task => <TaskCard key={task.id} task={task} onUpdate={handleUpdateTask} onEditTask={setEditingTask} onAssignTask={handleAssignTask} onRequestChanges={handleRequestChanges} onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask} projects={projects} scopeLabel={scopeLabelFor(task)} />)}
              </TabsContent>

              <TabsContent value="in-progress" className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 content-start flex-initial min-h-0 lg-content">
                {sortedTasks.filter(t => t.status === 'in-progress').map(task => <TaskCard key={task.id} task={task} onUpdate={handleUpdateTask} onEditTask={setEditingTask} onAssignTask={handleAssignTask} onRequestChanges={handleRequestChanges} onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask} projects={projects} scopeLabel={scopeLabelFor(task)} />)}
              </TabsContent>

              <TabsContent value="completed" className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 content-start flex-initial min-h-0 lg-content">
                {sortedTasks.filter(t => t.status === 'completed').map(task => <TaskCard key={task.id} task={task} onUpdate={handleUpdateTask} onEditTask={setEditingTask} onAssignTask={handleAssignTask} onRequestChanges={handleRequestChanges} onDismissChangeRequest={handleDismissChangeRequest} onDeleteTask={handleDeleteTask} projects={projects} scopeLabel={scopeLabelFor(task)} />)}
              </TabsContent>
            </Tabs> : viewMode === 'gantt' ? <div className="flex-initial min-h-0 lg-content">
              <GanttChart 
                tasks={sortedTasks}
                allTasks={sortedTasks}
                projectName={
                  selectedProjectId 
                    ? projects.find(p => p.id === selectedProjectId)?.name || 'Project'
                    : selectedSpecialList === 'today'
                    ? 'Today'
                    : selectedSpecialList === 'unassigned'
                    ? 'Unassigned Tasks'
                    : 'All Tasks'
                }
                projectId={selectedProjectId}
                projects={projects}
                groupBy={ganttGroupBy}
                userId={user?.id}
                onTaskClick={setEditingTask}
                onAddTask={handleAddTask}
                onOpenAddTask={() => handleAddTaskDialogOpen(true)}
              />
            </div> : <div className="flex-initial min-h-0 lg-content">
              {/* Archived included here on purpose (req #4): this is the one project
                  time-summary surface, so its per-project name/color lookup must not
                  drop an archived project's total into "Unassigned". */}
              <TimeTrackingChart tasks={sortedTasks} projects={allProjectsForReports} />
            </div>}
              </div>
            </div>

            {/* Desktop Docked Task Panel (right of main content, no overlay) */}
            {!isMobile && (
              editingTask ? (
                <EditTaskDialog
                  task={editingTask}
                  open={!!editingTask}
                  desktopDocked
                  highlight={editHighlight}
                  onOpenChange={(open) => {
                    if (!open && !showTaskTour && !showProjectsTour) {
                      setEditingTask(null);
                    }
                  }}
                  onUpdateTask={async (updatedTask) => {
                    await handleUpdateTask(updatedTask);
                    setEditingTask(null);
                  }}
                  // O2 2026-08-23: the Edit Task sheet's share icon only ever called
                  // this prop, which nothing wired up, so the purple pill needed a
                  // reload to appear. Same refresh the task-row share dialog uses.
                  onAssigned={() => { fetchTasks(); fetchSenderSharedItems(); noteShareEvent(); }}
                  sharedRecipients={senderSharedMap[editingTask.id]}
                  projects={orderedProjects}
                  currentUserId={user?.id}
                  onDeleteTask={handleDeleteTask}
                />
              ) : (
                <AddTaskDialog
                  open={addTaskDialogOpen}
                  onOpenChange={handleAddTaskDialogOpen}
                  onAddTask={handleAddTask}
                  selectedProjectId={selectedProjectId}
                  selectedSpecialList={selectedSpecialList}
                  projects={orderedProjects}
                  showTrigger={false}
                  desktopDocked
                />
              )
            )}
          </div>
        </div>

        {/* Radial FAB - compact (double-tap to return home). Hidden behind every
            modal surface, the one-bar sheets included — the FAB is not portalled,
            so without this it paints over an open sheet. */}
        {!dialogOpen && !settingsOpen && !editingTask && !addTaskDialogOpen && !onebarSheet && (
          <RecordFAB onBrainDump={() => navigate('/home?braindump=1')} />
        )}
      </div>
      
      <BrainDumpLiveDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        userId={user?.id || ''}
        projects={orderedProjects.map(p => ({ id: p.id, name: p.name }))}
        onProjectCreated={(newProjectId) => {
          setProjectRefreshTrigger(prev => prev + 1);
          setSelectedProjectId(newProjectId);
          setSelectedSpecialList(null);
        }}
        onTasksCreated={(createdRows) => {
          if (createdRows && createdRows.length) {
            const transformed = createdRows.map(transformDbTask);
            setAllTasks(prev => {
              const seen = new Set(prev.map(t => t.id));
              const merged = [...prev];
              for (const t of transformed) if (!seen.has(t.id)) merged.push(t);
              return merged;
            });
          }
          fetchTasks();
          setProjectRefreshTrigger(prev => prev + 1);
        }}
        onRecordingChange={setIsBrainDumpRecording}
      />

      <BottomNavWithSidebar
        projects={orderedProjects}
        preferences={preferences}
        prefsLoading={prefsLoading}
        onSavePreferences={updatePreferences}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
      />

      {/* OnboardingTour removed — HomeTour on /home replaces it */}

      {/* Mobile Add Task Dialog */}
      {isMobile && (
        <AddTaskDialog
          open={addTaskDialogOpen}
          onOpenChange={handleAddTaskDialogOpen}
          onAddTask={handleAddTask}
          selectedProjectId={selectedProjectId}
          selectedSpecialList={selectedSpecialList}
          projects={orderedProjects}
          showTrigger={false}
        />
      )}

      {/* Mobile Edit Task Dialog */}
      {isMobile && editingTask && (
        <EditTaskDialog
          task={editingTask}
          open={!!editingTask && !editClosing}
          highlight={editHighlight}
          onOpenChange={(open) => {
            if (!open && !showTaskTour && !showProjectsTour) {
              closeEditPane();
            }
          }}
          onUpdateTask={async (updatedTask) => {
            await handleUpdateTask(updatedTask);
            closeEditPane();
          }}
          // O2 2026-08-23: the Edit Task sheet's share icon only ever called
          // this prop, which nothing wired up, so the purple pill needed a
          // reload to appear. Same refresh the task-row share dialog uses.
          onAssigned={() => { fetchTasks(); fetchSenderSharedItems(); noteShareEvent(); }}
          sharedRecipients={senderSharedMap[editingTask.id]}
          projects={orderedProjects}
          currentUserId={user?.id}
                  onDeleteTask={handleDeleteTask}
        />
      )}

      <TaskTour isOpen={showTaskTour} onComplete={handleTaskTourComplete} onStepChange={handleTaskTourStepChange} />

      <ProjectTour isOpen={showProjectsTour} onComplete={handleProjectsTourComplete} onStepChange={handleProjectsTourStepChange} />

      <ShareItemDialog
        itemType="task"
        itemId={taskToShare?.id || null}
        itemTitle={taskToShare?.title}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        onShared={() => { fetchTasks(); fetchSenderSharedItems(); noteShareEvent(); }}
      />
      <ShareItemDialog
        itemType="project"
        itemId={selectedProjectId}
        itemTitle={projects.find(p => p.id === selectedProjectId)?.name}
        // O2 2026-08-23: this dialog had no onShared at all, so the project
        // pill (drawer row + bar) needed a reload to appear after a share.
        open={shareProjectDialogOpen}
        onOpenChange={setShareProjectDialogOpen}
        onShared={() => { fetchSenderSharedItems(); noteShareEvent(); }}
      />

      {/* Changes Needed Dialog */}
      <TouchDialog open={changesNeededDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setChangesNeededDialogOpen(false);
          setChangesNeededTask(null);
          setChangesNeededMessage('');
        }
      }}>
        <TouchDialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request Changes</DialogTitle>
            <DialogDescription>
              Describe what changes are needed for "{changesNeededTask?.title}". The recipient will be notified and the task will be reassigned to them.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Describe the changes needed..."
            value={changesNeededMessage}
            onChange={(e) => setChangesNeededMessage(e.target.value)}
            className="min-h-[100px]"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangesNeededDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmitChangesNeeded}
              disabled={!changesNeededMessage.trim() || changesNeededLoading}
              className="bg-accent hover:bg-accent/90 text-accent-foreground"
            >
              {changesNeededLoading ? 'Sending...' : 'Send Changes Request'}
            </Button>
          </DialogFooter>
        </TouchDialogContent>
      </TouchDialog>

      {/* Invite Project Member Dialog */}
      {selectedProjectId && (
        <InviteProjectMemberDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          projectId={selectedProjectId}
          projectName={projects.find(p => p.id === selectedProjectId)?.name || 'Project'}
          onInviteSent={() => setMemberRefreshTrigger(prev => prev + 1)}
        />
      )}

      {/* Delete-project confirm — one controlled instance serving both the
          desktop Delete button and the mobile ⋯ menu item */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project?</AlertDialogTitle>
            <AlertDialogDescription>
              By selecting Yes, you understand that the project and all the tasks within the Project will be deleted permanently. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive-project confirm — same one-controlled-instance shape as the
          Delete dialog above, serving both the desktop Archive button and the
          mobile ⋯ menu item. */}
      <AlertDialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Project?</AlertDialogTitle>
            <AlertDialogDescription>
              By selecting Yes, the project will be hidden from your project list, Today, Past Due, Gantt and search. Its tasks and tracked time are kept, and you can restore it anytime from the Archived section at the bottom of the drawer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchiveProject}>
              Yes, Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>;
};
export default Index;