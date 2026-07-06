import { LayoutDashboard, Building2, Bot, Users as UsersIcon, Link as LinkIcon, ClipboardList, Workflow, Plug, Flag, Sparkles, Video, BookOpen, CalendarCheck, MessageSquare, Landmark } from 'lucide-react';

const STATUTORY_OWNER_EMAIL = 'chauhandhaval932@gmail.com';

const readRole = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').role || ''; }
  catch { return ''; }
};
const readEmail = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').email || ''; }
  catch { return ''; }
};

// Is the logged-in user an admin? (role stored in localStorage 'user' by AuthContext)
export const isAdminUser = () => readRole() === 'admin';

// Is the logged-in user the developer/engineer?
export const isDeveloperUser = () => readRole() === 'developer';

// The developer (engineer) shell — focused on the feedback queue + plans.
export const DEVELOPER_SIDEBAR = [
  { path: '/chat',     label: 'Colonel AI', icon: Sparkles, testId: 'nav-chat' },
  { path: '/feedback', label: 'Feedback', icon: Flag,     testId: 'nav-feedback' },
  { path: '/plans',    label: 'Plans',    icon: Workflow, testId: 'nav-plans' },
];

// The admin sidebar — shown everywhere an admin goes, so running an agent or
// viewing analytics never ejects Anshul from the admin shell.
export const ADMIN_SIDEBAR = [
  { path: '/admin',             label: 'Dashboard',   icon: LayoutDashboard, testId: 'nav-dashboard' },
  { path: '/chat',              label: 'Colonel AI',  icon: Sparkles,        testId: 'nav-chat' },
  { path: '/admin/brands',      label: 'Brands',      icon: Building2,       testId: 'nav-brands' },
  { path: '/admin/agents',      label: 'Agents',      icon: Bot,             testId: 'nav-agents' },
  { path: '/admin/users',       label: 'Users',       icon: UsersIcon,       testId: 'nav-users' },
  { path: '/admin/tasks',       label: 'Tasks',       icon: ClipboardList,   testId: 'nav-tasks' },
  { path: '/admin/chats',       label: 'Chats',       icon: MessageSquare,   testId: 'nav-chats' },
  { path: '/admin/plans',       label: 'Plans',       icon: Workflow,        testId: 'nav-plans' },
  { path: '/admin/feedback',    label: 'Feedback',    icon: Flag,            testId: 'nav-feedback' },
  { path: '/admin/integrations',label: 'Integrations',icon: Plug,            testId: 'nav-integrations' },
  { path: '/admin/assignments', label: 'Assignments', icon: LinkIcon,        testId: 'nav-assignments' },
];

// Any /admin/* route is admin-only (enforced by ProtectedRoute), so the path is
// an authoritative admin signal — more reliable than the localStorage role read,
// which can momentarily lag/clear and wrongly drop a page to the accountant menu.
const onAdminRoute = () => {
  try { return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin'); }
  catch { return false; }
};

// Pick the right sidebar: admins keep the admin menu; accountants get their
// brand-scoped menu PLUS global Tasks + Plans (so they can see assigned tasks
// and plans shared with them from anywhere).
// Remember the accountant's current brand so brand-scoped nav items (Dashboard,
// Agents) stay linkable from GLOBAL pages (Meetings, Tasks, Feedback…) too.
const lastBrandId = () => { try { return localStorage.getItem('lastBrandId') || ''; } catch { return ''; } };

export const sidebarFor = (brandItems = []) => {
  if (isAdminUser() || onAdminRoute()) return ADMIN_SIDEBAR;
  if (isDeveloperUser()) return DEVELOPER_SIDEBAR;
  // Accountant: the SAME full menu on every page, so navigating to Meetings/
  // Tasks/etc. never drops Dashboard/Agents from the shell. Brand-scoped items
  // link to the last-visited brand (falls back to the brand picker).
  const bid = lastBrandId();
  const dashPath = bid ? `/brands/${bid}/dashboard` : '/brands';
  const agentsPath = bid ? `/brands/${bid}/agents` : '/brands';
  const compliancePath = bid ? `/brands/${bid}/compliance-tracker` : '/brands';
  const statutoryPath = bid ? `/brands/${bid}/statutory-compliance` : '/brands';
  const base = [
    { path: dashPath,        label: 'Dashboard',   icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: agentsPath,      label: 'Agents',      icon: Bot,             testId: 'nav-agents' },
    { path: compliancePath,  label: 'Tracker',     icon: CalendarCheck,   testId: 'nav-compliance' },
    // Statutory Compliance — private to the owner email only.
    ...(readEmail() === STATUTORY_OWNER_EMAIL
      ? [{ path: statutoryPath, label: 'Statutory Compliance', icon: Landmark, testId: 'nav-statutory' }]
      : []),
    { path: '/chat',         label: 'Colonel AI',  icon: Sparkles,        testId: 'nav-chat' },
    { path: '/meetings',     label: 'Meetings',    icon: Video,           testId: 'nav-meetings' },
    { path: '/tasks',        label: 'Tasks',       icon: ClipboardList,   testId: 'nav-tasks' },
    { path: '/feedback',     label: 'Feedback',    icon: Flag,            testId: 'nav-feedback' },
    { path: '/integrations', label: 'Integrations',icon: Plug,            testId: 'nav-integrations' },
    { path: '/zoho',         label: 'Zoho Books',  icon: BookOpen,        testId: 'nav-zoho' },
    { path: '/plans',        label: 'Plans',       icon: Workflow,        testId: 'nav-plans' },
    { path: '/brands',       label: 'Switch brands',icon: Building2,       testId: 'nav-switch-brands' },
  ];
  // Let a caller override brand-scoped paths with the EXACT current brand
  // (matched by label), then keep the canonical base order. Any extra caller
  // item that collides with a base path OR label is dropped (e.g. TasksPage /
  // PlansPage pass their own '/brands' "Brands" — base's "Switch brands" wins).
  const byLabel = new Map(base.map((it) => [it.label, it]));
  for (const it of brandItems) byLabel.set(it.label, it);
  const merged = base.map((it) => byLabel.get(it.label));
  const basePaths = new Set(base.map((b) => b.path));
  const baseLabels = new Set(base.map((b) => b.label));
  const extra = brandItems.filter((it) => !baseLabels.has(it.label) && !basePaths.has(it.path));
  return [...merged, ...extra];
};
