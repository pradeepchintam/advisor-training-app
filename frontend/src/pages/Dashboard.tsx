import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { sessionsApi, assignmentsApi } from '../services/api';
import type { Assignment, MyAssignments, SessionPublic } from '../types';
import PersonaBadge from '../components/PersonaBadge';
import { useToast } from '../components/Toast';
import { getErrorMessage } from '../utils/errors';

function ScoreBadge({ score, max = 10 }: { score: number | null | undefined; max?: number }) {
  if (score == null) return <span className="text-slate-500 text-sm">—</span>;
  const pct = score / max;
  const cls =
    pct >= 0.8
      ? 'bg-green-900 text-green-300'
      : pct >= 0.5
      ? 'bg-yellow-900 text-yellow-300'
      : 'bg-red-900 text-red-300';
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{score.toFixed(1)}/{max}</span>;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
      <div className="text-slate-500 text-sm font-medium mb-1">{label}</div>
      <div className="text-3xl font-bold text-white">{value}</div>
      {sub && <div className="text-slate-500 text-xs mt-1">{sub}</div>}
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDuration(start: string, end: string | null) {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function StatusPill({ status }: { status: Assignment['status'] }) {
  const map: Record<string, string> = {
    pending: 'bg-blue-900/40 text-blue-300',
    in_progress: 'bg-yellow-900/40 text-yellow-300',
    completed: 'bg-green-900/40 text-green-300',
    cancelled: 'bg-navy-700 text-slate-400',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-navy-700 text-slate-400'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

/**
 * Tabular list of assignments.
 *  - `startable` table (today/overdue) shows a Start button.
 *  - non-startable table (future) shows the scheduled date only — advisors
 *    cannot start a session before its scheduled day.
 */
function AssignmentTable({
  assignments,
  startable,
  today,
}: {
  assignments: Assignment[];
  startable: boolean;
  today: string;
}) {
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-navy-700">
            <th className="px-5 py-3 font-medium">Appointment</th>
            <th className="px-4 py-3 font-medium">Client</th>
            <th className="px-4 py-3 font-medium">{startable ? 'Due' : 'Scheduled'}</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium text-right">{startable ? 'Action' : ''}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-700">
          {assignments.map((a) => {
            const overdue = startable && a.target_date < today;
            // Defensive: never allow starting a session before its scheduled date.
            const canStart = startable && a.target_date <= today;
            return (
              <tr key={a.id} className="hover:bg-navy-700/40 transition-colors">
                <td className="px-5 py-3">
                  <div className="text-white font-medium">{a.profile_name}</div>
                  <div className="text-slate-500 text-xs mt-0.5">
                    {a.persona.age_group?.replace('_', ' ')} · {a.persona.financial_situation} · {a.persona.personality_type}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-300">{a.persona.name || '—'}</td>
                <td className="px-4 py-3">
                  <span className="text-slate-300">{a.target_date}</span>
                  {overdue && (
                    <span className="ml-2 inline-flex px-1.5 py-0.5 rounded bg-red-900/50 text-red-300 text-[10px] uppercase tracking-wider font-semibold">
                      Overdue
                    </span>
                  )}
                </td>
                <td className="px-4 py-3"><StatusPill status={a.status} /></td>
                <td className="px-4 py-3 text-right">
                  {canStart ? (
                    <Link
                      to={`/sessions/start/${a.id}`}
                      className="inline-flex items-center bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-1.5 rounded-lg transition-colors text-xs"
                    >
                      Start →
                    </Link>
                  ) : (
                    <span className="text-slate-500 text-xs italic">
                      Available {a.target_date}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [myAssignments, setMyAssignments] = useState<MyAssignments | null>(null);

  useEffect(() => {
    sessionsApi
      .list()
      .then(setSessions)
      .catch((err) => {
        console.error('Dashboard load error:', err);
        toast.error(`Failed to load dashboard: ${getErrorMessage(err)}`);
      })
      .finally(() => setLoading(false));

    // Assignments only matter for advisors. Admins skip this fetch.
    if (!isAdmin) {
      assignmentsApi
        .listMine()
        .then(setMyAssignments)
        .catch((err) => {
          // Non-fatal — dashboard still renders without the assignment sections
          console.warn('Failed to load assignments:', err);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = todayIso();

  const now = new Date();
  const thisMonthSessions = sessions.filter((s) => {
    const d = new Date(s.started_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const completedSessions = sessions.filter((s) => s.status === 'completed');
  const scoredSessions = completedSessions.filter((s) => s.overall_score != null);
  // Normalize each score to a 0–10 scale before averaging so a history mixing
  // legacy 1–10 with new 1–5 scorecard sessions reads as a fair aggregate.
  const avgScore =
    scoredSessions.length > 0
      ? scoredSessions.reduce(
          (sum, s) => sum + (s.overall_score ?? 0) * (10 / (s.score_scale ?? 10)),
          0,
        ) / scoredSessions.length
      : null;

  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, 5);

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Welcome back, {user?.name?.split(' ')[0] ?? 'Advisor'}
          </h1>
          <p className="text-slate-500 mt-1">
            {isAdmin ? 'Admin Dashboard · All advisor activity' : 'Your training overview'}
          </p>
        </div>
        <Link
          to="/sessions/new"
          className="inline-flex items-center gap-2 bg-navy-700 hover:bg-navy-600 text-slate-200 font-bold px-5 py-2.5 rounded-lg transition-colors border border-navy-600"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
          </svg>
          Start Additional Session
        </Link>
      </div>

      {/* Assigned sessions — advisors only */}
      {!isAdmin && myAssignments && (
        <>
          {/* Today's assignments — startable */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">Today's Assigned Sessions</h2>
              <span className="text-xs text-slate-500">
                {myAssignments.today.length} {myAssignments.today.length === 1 ? 'session' : 'sessions'}
              </span>
            </div>
            {myAssignments.today.length === 0 ? (
              <div className="bg-navy-800 border border-navy-700 rounded-xl px-5 py-6 text-center text-slate-500 text-sm">
                Nothing due today. Nice — you're caught up.
              </div>
            ) : (
              <AssignmentTable assignments={myAssignments.today} startable today={today} />
            )}
          </div>

          {/* Upcoming assignments — NOT startable until their scheduled date */}
          {myAssignments.upcoming.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-white">Upcoming Sessions</h2>
                <span className="text-xs text-slate-500">
                  {myAssignments.upcoming.length} scheduled
                </span>
              </div>
              <AssignmentTable assignments={myAssignments.upcoming} startable={false} today={today} />
              <p className="text-slate-500 text-xs mt-2">
                Upcoming sessions become available to start on their scheduled date.
              </p>
            </div>
          )}
        </>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard label="Total Sessions" value={sessions.length} sub="All time" />
        <StatCard
          label="Average Score"
          value={avgScore != null ? avgScore.toFixed(1) : '—'}
          sub="Completed sessions"
        />
        <StatCard
          label="This Month"
          value={thisMonthSessions.length}
          sub="Sessions completed"
        />
      </div>

      {/* Recent Sessions */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
          <h2 className="font-semibold text-white">Recent Sessions</h2>
          <Link to="/sessions" className="text-gold-400 hover:text-gold-300 text-sm transition-colors">
            View all →
          </Link>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <svg className="animate-spin h-8 w-8 text-gold-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : recentSessions.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-slate-500 mb-4">No sessions yet</div>
            <Link
              to="/sessions/new"
              className="inline-flex items-center gap-2 bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg text-sm transition-colors"
            >
              Start your first session
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-navy-700">
                <th className="px-6 py-3 font-medium">Client</th>
                {isAdmin && <th className="px-4 py-3 font-medium">Advisor</th>}
                <th className="px-4 py-3 font-medium">Persona</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {recentSessions.map((session) => (
                <tr key={session.id} className="hover:bg-navy-700/50 transition-colors">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-xs text-slate-400 flex-shrink-0">
                        {session.client_name?.[0] ?? '?'}
                      </div>
                      <span className="text-white text-sm font-medium">{session.client_name}</span>
                    </div>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3 text-slate-400 text-sm">{session.advisor_name ?? '—'}</td>
                  )}
                  <td className="px-4 py-3">
                    <PersonaBadge persona={session.persona} compact />
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-sm">{formatDate(session.started_at)}</td>
                  <td className="px-4 py-3 text-slate-400 text-sm">
                    {formatDuration(session.started_at, session.ended_at)}
                  </td>
                  <td className="px-4 py-3">
                    <ScoreBadge score={session.overall_score} max={session.score_scale ?? 10} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        session.status === 'completed'
                          ? 'bg-green-900/50 text-green-400'
                          : session.status === 'active'
                          ? 'bg-blue-900/50 text-blue-400'
                          : 'bg-red-900/50 text-red-400'
                      }`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/sessions/${session.id}`}
                      className="text-gold-400 hover:text-gold-300 text-sm transition-colors"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
