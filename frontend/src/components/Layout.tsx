import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

function NavIcon({ children }: { children: React.ReactNode }) {
  return <span className="w-5 h-5 flex-shrink-0">{children}</span>;
}

const DashboardIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
    </svg>
  </NavIcon>
);

const PlusIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
    </svg>
  </NavIcon>
);

const ListIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
    </svg>
  </NavIcon>
);

const UsersIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
    </svg>
  </NavIcon>
);

const ClipboardIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
      <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
    </svg>
  </NavIcon>
);

const ChartIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
    </svg>
  </NavIcon>
);

const EyeIcon = () => (
  <NavIcon>
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
      <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
    </svg>
  </NavIcon>
);

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const advisorNav: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
    { to: '/sessions/new', label: 'New Session', icon: <PlusIcon /> },
    { to: '/sessions', label: 'Session History', icon: <ListIcon /> },
  ];

  const adminNav: NavItem[] = [
    { to: '/admin', label: 'Admin Dashboard', icon: <ChartIcon /> },
    { to: '/admin/advisors', label: 'Manage Advisors', icon: <UsersIcon /> },
    { to: '/admin/questionnaire', label: 'Questionnaire', icon: <ClipboardIcon /> },
    { to: '/admin/presentation', label: 'Presentation', icon: <ClipboardIcon /> },
    { to: '/admin/script', label: 'Script', icon: <ClipboardIcon /> },
    { to: '/admin/sessions', label: 'Review Sessions', icon: <EyeIcon /> },
  ];

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '?';

  return (
    <div className="flex h-screen bg-navy-900 overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-navy-900 border-r border-navy-700 transition-all duration-300 ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-navy-700">
          <div className="flex-shrink-0 w-8 h-8 bg-gold-500 rounded-lg flex items-center justify-center">
            <span className="text-navy-900 font-black text-sm">TW</span>
          </div>
          {!sidebarCollapsed && (
            <div>
              <div className="text-gold-400 font-bold text-sm leading-tight">Trajan Wealth</div>
              <div className="text-slate-500 text-xs">Advisor Trainer</div>
            </div>
          )}
          <button
            className="ml-auto text-slate-500 hover:text-slate-300 transition-colors"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              {sidebarCollapsed ? (
                <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
              ) : (
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              )}
            </svg>
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 overflow-y-auto">
          {!isAdmin && (
            <>
              {!sidebarCollapsed && (
                <div className="px-3 mb-1">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Training</span>
                </div>
              )}
              {advisorNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/sessions'}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 mx-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-gold-500/10 text-gold-400 font-medium'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-navy-800'
                    }`
                  }
                >
                  {item.icon}
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </>
          )}

          {isAdmin && (
            <>
              <div className={`px-3 mt-4 mb-1 ${sidebarCollapsed ? 'hidden' : ''}`}>
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Admin</span>
              </div>
              {sidebarCollapsed && <div className="my-2 mx-3 border-t border-navy-700" />}
              {adminNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/admin'}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 mx-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-gold-500/10 text-gold-400 font-medium'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-navy-800'
                    }`
                  }
                >
                  {item.icon}
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* User info */}
        <div className="border-t border-navy-700 p-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-gold-400 font-semibold text-xs flex-shrink-0">
              {initials}
            </div>
            {!sidebarCollapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white font-medium truncate">{user?.name}</div>
                <div className="text-xs text-slate-500 truncate capitalize">{user?.role}</div>
              </div>
            )}
            <button
              onClick={handleLogout}
              title="Logout"
              className="flex-shrink-0 text-slate-500 hover:text-red-400 transition-colors p-1 rounded"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 bg-navy-800 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
