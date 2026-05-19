import React from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { sessionsApi } from './services/api';
import Layout from './components/Layout';

// Pages
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import NewSession from './pages/NewSession';
import Session from './pages/Session';
import SessionDetail from './pages/SessionDetail';
import SessionHistory from './pages/SessionHistory';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdvisorManagement from './pages/admin/AdvisorManagement';
import QuestionnaireEditor from './pages/admin/QuestionnaireEditor';
import AdminSessionReview from './pages/admin/AdminSessionReview';
import PresentationManagement from './pages/admin/PresentationManagement';
import ScriptEditor from './pages/admin/ScriptEditor';

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-navy-900 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 bg-gold-500 rounded-xl flex items-center justify-center">
          <span className="text-navy-900 font-black text-lg">TW</span>
        </div>
        <svg className="animate-spin h-6 w-6 text-gold-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    </div>
  );
}

function ProtectedRoute({
  children,
  adminOnly = false,
  advisorOnly = false,
}: {
  children: React.ReactNode;
  adminOnly?: boolean;
  advisorOnly?: boolean;
}) {
  const { isAuthenticated, isAdmin, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (adminOnly && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  if (advisorOnly && isAdmin) {
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
}

function RoleHomeRedirect() {
  const { isAdmin } = useAuth();
  return <Navigate to={isAdmin ? '/admin' : '/dashboard'} replace />;
}

/**
 * Smart session router: checks if session is active → shows live Session page
 * (no layout), or completed → shows SessionDetail inside layout.
 */
function SessionRoute() {
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = React.useState<'loading' | 'active' | 'done'>('loading');

  React.useEffect(() => {
    if (!id) { setStatus('done'); return; }
    sessionsApi
      .get(id)
      .then((s) => setStatus(s.status === 'active' ? 'active' : 'done'))
      .catch(() => setStatus('done'));
  }, [id]);

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'active') return <Session />;

  return (
    <Layout>
      <SessionDetail />
    </Layout>
  );
}

export default function App() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) return <LoadingScreen />;

  return (
    <Routes>
      {/* Public */}
      <Route
        path="/login"
        element={isAuthenticated ? <RoleHomeRedirect /> : <Login />}
      />

      {/* Session page (smart: active = full-screen, completed = with layout) */}
      <Route
        path="/sessions/:id"
        element={
          <ProtectedRoute>
            <SessionRoute />
          </ProtectedRoute>
        }
      />

      {/* All other protected routes share the sidebar layout */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <RoleHomeRedirect />
          </ProtectedRoute>
        }
      />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute advisorOnly>
            <Layout><Dashboard /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/sessions/new"
        element={
          <ProtectedRoute advisorOnly>
            <Layout><NewSession /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/sessions"
        element={
          <ProtectedRoute advisorOnly>
            <Layout><SessionHistory /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin"
        element={
          <ProtectedRoute adminOnly>
            <Layout><AdminDashboard /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/advisors"
        element={
          <ProtectedRoute adminOnly>
            <Layout><AdvisorManagement /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/questionnaire"
        element={
          <ProtectedRoute adminOnly>
            <Layout><QuestionnaireEditor /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/sessions"
        element={
          <ProtectedRoute adminOnly>
            <Layout><AdminSessionReview /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/presentation"
        element={
          <ProtectedRoute adminOnly>
            <Layout><PresentationManagement /></Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/script"
        element={
          <ProtectedRoute adminOnly>
            <Layout><ScriptEditor /></Layout>
          </ProtectedRoute>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<RoleHomeRedirect />} />
    </Routes>
  );
}
