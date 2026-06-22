import { LayoutDashboard, Building2, Bot, Users as UsersIcon, Link as LinkIcon, ClipboardList, Workflow, Plug, Flag, Sparkles } from 'lucide-react';

const readRole = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').role || ''; }
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
export const sidebarFor = (brandItems) => {
  if (isAdminUser() || onAdminRoute()) return ADMIN_SIDEBAR;
  if (isDeveloperUser()) return DEVELOPER_SIDEBAR;
  // Accountant: brand-scoped items + global Tasks/Plans. Some callers already
  // include a Tasks/Plans item in brandItems, so dedupe by path (first wins) to
  // avoid the doubled "Tasks · Tasks" the user saw.
  const items = [
    ...brandItems,
    { path: '/chat',  label: 'Colonel AI', icon: Sparkles, testId: 'nav-chat' },
    { path: '/tasks', label: 'Tasks', icon: ClipboardList, testId: 'nav-tasks' },
    { path: '/plans', label: 'Plans', icon: Workflow, testId: 'nav-plans' },
  ];
  const seen = new Set();
  return items.filter((it) => (seen.has(it.path) ? false : (seen.add(it.path), true)));
};
