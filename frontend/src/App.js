import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { Toaster } from 'sonner';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
// ── Admin pages ───────────────────────────────────────────────────────────────
import AdminDashboard    from './pages/admin/AdminDashboard';
import BrandsPage        from './pages/admin/BrandsPage';
import AgentsPage        from './pages/admin/AgentsPage';
import AssignmentsPage   from './pages/admin/AssignmentsPage';
import BrandOverviewPage from './pages/admin/BrandOverviewPage';
import UsersPage         from './pages/admin/UsersPage';
import TasksPage         from './pages/admin/TasksPage';
import AdminChats        from './pages/admin/AdminChats';
import AdminStatutory     from './pages/admin/AdminStatutory';
import DatabasePage       from './pages/admin/DatabasePage';
import PlansPage         from './pages/admin/PlansPage';
import PlanEditor        from './pages/admin/PlanEditor';
import IntegrationsPage  from './pages/admin/IntegrationsPage';
import MeetingsPage      from './pages/accountant/MeetingsPage';
import ZohoBooksPage     from './pages/accountant/ZohoBooksPage';
import FeedbackPage      from './pages/developer/FeedbackPage';
// ── Accountant pages ──────────────────────────────────────────────────────────
import BrandSelection        from './pages/accountant/BrandSelection';
import BrandDashboard        from './pages/accountant/BrandDashboard';
import AnalysisPage          from './pages/accountant/AnalysisPage';
import AnalysisAgentPage     from './pages/accountant/AnalysisAgentPage';
import AnalysisMetricPage    from './pages/accountant/AnalysisMetricPage';
import AdminAnalysisPage     from './pages/admin/AdminAnalysisPage';
import AdminToolDetailPage   from './pages/admin/AdminToolDetailPage';
import AdminUserDetailPage   from './pages/admin/AdminUserDetailPage';
import BrandAgentsInventory  from './pages/accountant/BrandAgentsInventory';
import AgentWorkspace        from './pages/accountant/AgentWorkspace';
import AgentDispatch         from './pages/accountant/AgentDispatch';
// ── Reco suite ────────────────────────────────────────────────────────────────
import RecoWorkspace         from './pages/accountant/RecoWorkspace';
import RecoMultiStateWorkspace from './pages/accountant/RecoMultiStateWorkspace';
import PdfBankExtractorWorkspace from './pages/accountant/PdfBankExtractorWorkspace';
import RecoJobDashboard      from './pages/accountant/RecoJobDashboard';
import ReceivableDashboard   from './pages/accountant/ReceivableDashboard';
import ComplianceTracker     from './pages/accountant/ComplianceTracker';
import StatutoryTracker      from './pages/accountant/StatutoryTracker';
import StatutoryRedirect     from './pages/accountant/StatutoryRedirect';

// ── Colonel AI (Round 3) ──────────────────────────────────────────────────────
import ColonelChat           from './pages/ColonelChat';
import './App.css';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors />
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* ── Admin panel ──────────────────────────────────────────────── */}
          <Route
            path="/admin/*"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <Routes>
                  <Route path="/"            element={<AdminDashboard />} />
                  <Route path="/analysis"    element={<AdminAnalysisPage />} />
                  <Route path="/analysis/tool/:agentType" element={<AdminToolDetailPage />} />
                  <Route path="/analysis/user/:userId"    element={<AdminUserDetailPage />} />
                  <Route path="/brands"      element={<BrandsPage />} />
                  <Route path="/brands/:id"  element={<BrandOverviewPage />} />
                  <Route path="/agents"      element={<AgentsPage />} />
                  <Route path="/users"       element={<UsersPage />} />
                  <Route path="/tasks"       element={<TasksPage />} />
                  <Route path="/chats"       element={<AdminChats />} />
                  <Route path="/statutory"   element={<AdminStatutory />} />
                  <Route path="/database"    element={<DatabasePage />} />
                  <Route path="/plans"       element={<PlansPage />} />
                  <Route path="/plans/:id"   element={<PlanEditor />} />
                  <Route path="/integrations" element={<IntegrationsPage />} />
                  <Route path="/feedback"    element={<FeedbackPage />} />
                  <Route path="/assignments" element={<AssignmentsPage />} />
                </Routes>
              </ProtectedRoute>
            }
          />

          {/* ── Colonel AI chat (all signed-in roles) ─────────────────────── */}
          <Route
            path="/chat"
            element={
              <ProtectedRoute allowedRoles={['admin', 'accountant', 'developer']}>
                <ColonelChat />
              </ProtectedRoute>
            }
          />

          {/* ── Brand selection ───────────────────────────────────────────── */}
          <Route
            path="/brands"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <BrandSelection />
              </ProtectedRoute>
            }
          />

          {/* ── Tasks (accountant view; admin uses /admin/tasks) ──────────── */}
          <Route
            path="/tasks"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <TasksPage />
              </ProtectedRoute>
            }
          />

          {/* ── Feedback (developer engineer view + accountant's own raised items; admin uses /admin/feedback) ── */}
          <Route
            path="/feedback"
            element={
              <ProtectedRoute allowedRoles={['developer', 'admin', 'accountant']}>
                <FeedbackPage />
              </ProtectedRoute>
            }
          />

          {/* ── Integrations (accountant + admin; admin also uses /admin/integrations) ── */}
          <Route
            path="/integrations"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <IntegrationsPage />
              </ProtectedRoute>
            }
          />

          {/* ── Meetings (calendar + recordings; accountant + admin) ── */}
          <Route
            path="/meetings"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <MeetingsPage />
              </ProtectedRoute>
            }
          />

          {/* ── Zoho Books (read-only mirror; accountant + admin + developer) ── */}
          <Route
            path="/zoho"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin', 'developer']}>
                <ZohoBooksPage />
              </ProtectedRoute>
            }
          />

          {/* ── Plans (accountant view of shared plans; developer builds plans) ── */}
          <Route
            path="/plans"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin', 'developer']}>
                <PlansPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/plans/:id"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin', 'developer']}>
                <PlanEditor />
              </ProtectedRoute>
            }
          />

          {/* ── Brand dashboard ───────────────────────────────────────────── */}
          <Route
            path="/brands/:brandId/dashboard"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <BrandDashboard />
              </ProtectedRoute>
            }
          />

          {/* ── Brand analysis (accountant deep analytics) ───────────────── */}
          <Route
            path="/brands/:brandId/analysis"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <AnalysisPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands/:brandId/analysis/agent/:agentType"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <AnalysisAgentPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands/:brandId/analysis/metric/:metric"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <AnalysisMetricPage />
              </ProtectedRoute>
            }
          />

          {/* ── Compliance Tracker (monthly workflow) ────────────────────── */}
          <Route
            path="/brands/:brandId/compliance-tracker"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <ComplianceTracker />
              </ProtectedRoute>
            }
          />

          {/* ── Statutory Compliance (brand-scoped: any assigned accountant) ─ */}
          {/* Brandless entry — resolves to the right brand (no more /brands bounce). */}
          <Route
            path="/statutory-compliance"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <StatutoryRedirect />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands/:brandId/statutory-compliance"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <StatutoryTracker />
              </ProtectedRoute>
            }
          />

          {/* ── Agent inventory + generic workspace ──────────────────────── */}
          <Route
            path="/brands/:brandId/agents"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <BrandAgentsInventory />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands/:brandId/agents/:agentId"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <AgentDispatch />
              </ProtectedRoute>
            }
          />

          {/* ── PDF Bank Extractor — no DB storage ───────────────────────── */}
          <Route
            path="/brands/:brandId/pdf-bank"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <PdfBankExtractorWorkspace />
              </ProtectedRoute>
            }
          />

          {/* ── Reco suite — specific multistate route first ─────────────── */}
          <Route
            path="/brands/:brandId/reco/gstr_2b_books_multistate"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <RecoMultiStateWorkspace />
              </ProtectedRoute>
            }
          />
          {/* /reco standalone listing no longer used — agents inventory is the entry point */}
          <Route
            path="/brands/:brandId/reco/:agentType"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <RecoWorkspace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands/:brandId/reco/:agentType/results/:jobId"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <RecoJobDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands/:brandId/receivables"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <ReceivableDashboard />
              </ProtectedRoute>
            }
          />

          <Route path="/" element={<Navigate to="/login" replace />} />

          <Route
            path="/unauthorized"
            element={
              <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <div className="text-center">
                  <h1 className="text-2xl font-bold text-slate-900 mb-2">Unauthorized</h1>
                  <p className="text-slate-600 mb-4">You don't have permission to access this page</p>
                  <a href="/login" className="text-blue-600 hover:underline">Go to Login</a>
                </div>
              </div>
            }
          />

          <Route
            path="*"
            element={
              <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <div className="text-center">
                  <h1 className="text-4xl font-bold text-slate-900 mb-2">404</h1>
                  <p className="text-slate-600 mb-4">Page not found</p>
                  <a href="/login" className="text-blue-600 hover:underline">Go to Login</a>
                </div>
              </div>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
