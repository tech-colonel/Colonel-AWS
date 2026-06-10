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
// ── Accountant pages ──────────────────────────────────────────────────────────
import BrandSelection        from './pages/accountant/BrandSelection';
import BrandDashboard        from './pages/accountant/BrandDashboard';
import BrandAgentsInventory  from './pages/accountant/BrandAgentsInventory';
import AgentWorkspace        from './pages/accountant/AgentWorkspace';
import AgentDispatch         from './pages/accountant/AgentDispatch';
// ── Reco suite ────────────────────────────────────────────────────────────────
import RecoWorkspace         from './pages/accountant/RecoWorkspace';
import RecoMultiStateWorkspace from './pages/accountant/RecoMultiStateWorkspace';
import RecoJobDashboard      from './pages/accountant/RecoJobDashboard';
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
                  <Route path="/brands"      element={<BrandsPage />} />
                  <Route path="/brands/:id"  element={<BrandOverviewPage />} />
                  <Route path="/agents"      element={<AgentsPage />} />
                  <Route path="/assignments" element={<AssignmentsPage />} />
                </Routes>
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

          {/* ── Brand dashboard ───────────────────────────────────────────── */}
          <Route
            path="/brands/:brandId/dashboard"
            element={
              <ProtectedRoute allowedRoles={['accountant', 'admin']}>
                <BrandDashboard />
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
