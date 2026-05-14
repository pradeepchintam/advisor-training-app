import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { advisorsApi, sessionsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import type { AdvisorWithStats, SessionPublic } from '../../types';
import { getErrorMessage } from '../../utils/errors';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-slate-500 text-sm">—</span>;
  const cls =
    score >= 8 ? 'bg-green-900 text-green-300' : score >= 5 ? 'bg-yellow-900 text-yellow-300' : 'bg-red-900 text-red-300';
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{score.toFixed(1)}</span>;
}

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <div className={`bg-navy-800 border rounded-xl p-5 ${accent ? 'border-gold-500/30' : 'border-navy-700'}`}>
      <div className="text-slate-500 text-sm font-medium mb-1">{label}</div>
      <div className={`text-3xl font-bold ${accent ? 'text-gold-400' : 'text-white'}`}>{value}</div>
      {sub && <div className="text-slate-500 text-xs mt-1">{sub}</div>}
    </div>
  );
}

export default function AdminDashboard() {
  const toast = useToast();
  const [advisors, setAdvisors] = useState<AdvisorWithStats[]>([]);
  const [sessions, setSessions] = useState<SessionPublic[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([advisorsApi.list(), sessionsApi.list()])
      .then(([a, s]) => { setAdvisors(a); setSessions(s); })
      .catch((err) => toast.error(`Failed to load dashboard data: ${getErrorMessage(err)}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeAdvisors = advisors.filter((a) => a.is_active).length;
  const completedSessions = sessions.filter((s) => s.status === 'completed');
  const scoredSessions = completedSessions.filter((s) => s.overall_score != null);
  const avgScore =
    scoredSessions.length > 0
      ? scoredSessions.reduce((sum, s) => sum + (s.overall_score ?? 0), 0) / scoredSessions.length
      : null;

  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, 8);

  const topAdvisors = [...advisors]
    .filter((a) => a.avg_score != null)
    .sort((a, b) => (b.avg_score ?? 0) - (a.avg_score ?? 0))
    .slice(0, 5);

  const bottomAdvisors = [...advisors]
    .filter((a) => a.avg_score != null && a.total_sessions >= 2)
    .sort((a, b) => (a.avg_score ?? 0) - (b.avg_score ?? 0))
    .slice(0, 3);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <svg className="animate-spin h-10 w-10 text-gold-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
          <p className="text-slate-500 mt-1">Platform-wide training overview</p>
        </div>
        <div className="flex gap-3">
          <Link to="/admin/advisors" className="bg-navy-700 hover:bg-navy-600 text-white px-4 py-2 rounded-lg text-sm transition-colors">
            Manage Advisors
          </Link>
          <Link to="/admin/questionnaire" className="bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg text-sm transition-colors">
            Edit Questionnaire
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Advisors" value={advisors.length} sub={`${activeAdvisors} active`} />
        <StatCard label="Total Sessions" value={sessions.length} sub="All time" />
        <StatCard label="Completed Sessions" value={completedSessions.length} sub="With full analysis" />
        <StatCard label="Platform Avg Score" value={avgScore != null ? avgScore.toFixed(1) : '—'} sub="All scored sessions" accent />
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Advisor Performance Table */}
        <div className="col-span-2 bg-navy-800 border border-navy-700 rounded-xl">
          <div className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
            <h2 className="font-semibold text-white">Advisor Performance</h2>
            <Link to="/admin/advisors" className="text-gold-400 hover:text-gold-300 text-sm">
              Manage →
            </Link>
          </div>
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-navy-700">
                <th className="px-6 py-3 font-medium">Advisor</th>
                <th className="px-4 py-3 font-medium">Sessions</th>
                <th className="px-4 py-3 font-medium">This Month</th>
                <th className="px-4 py-3 font-medium">Avg Score</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {advisors.map((advisor) => (
                <tr key={advisor.id} className="hover:bg-navy-700/50 transition-colors">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-navy-700 flex items-center justify-center text-xs text-gold-400 font-bold flex-shrink-0">
                        {advisor.name?.[0] ?? '?'}
                      </div>
                      <div>
                        <div className="text-white text-sm font-medium">{advisor.name}</div>
                        <div className="text-slate-500 text-xs">{advisor.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-sm">{advisor.total_sessions}</td>
                  <td className="px-4 py-3 text-slate-400 text-sm">{advisor.sessions_this_month}</td>
                  <td className="px-4 py-3">
                    <ScoreBadge score={advisor.avg_score} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        advisor.is_active ? 'bg-green-900/50 text-green-400' : 'bg-slate-800 text-slate-500'
                      }`}
                    >
                      {advisor.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
              {advisors.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-500 py-8">No advisors yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Top Performers */}
          {topAdvisors.length > 0 && (
            <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
              <h3 className="font-semibold text-green-400 mb-3 text-sm">Top Performers</h3>
              <div className="space-y-2">
                {topAdvisors.map((a, i) => (
                  <div key={a.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-600 text-xs w-4">{i + 1}.</span>
                      <span className="text-slate-300 text-sm">{a.name}</span>
                    </div>
                    <ScoreBadge score={a.avg_score} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Needs Coaching */}
          {bottomAdvisors.length > 0 && (
            <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
              <h3 className="font-semibold text-orange-400 mb-3 text-sm">Needs Coaching</h3>
              <div className="space-y-2">
                {bottomAdvisors.map((a) => (
                  <div key={a.id} className="flex items-center justify-between">
                    <span className="text-slate-300 text-sm">{a.name}</span>
                    <ScoreBadge score={a.avg_score} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick Links */}
          <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Quick Links</h3>
            <div className="space-y-2">
              <Link to="/admin/advisors" className="block text-gold-400 hover:text-gold-300 text-sm transition-colors">
                → Manage Advisors
              </Link>
              <Link to="/admin/questionnaire" className="block text-gold-400 hover:text-gold-300 text-sm transition-colors">
                → Edit Questionnaire
              </Link>
              <Link to="/admin/sessions" className="block text-gold-400 hover:text-gold-300 text-sm transition-colors">
                → Review All Sessions
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Sessions */}
      <div className="mt-6 bg-navy-800 border border-navy-700 rounded-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
          <h2 className="font-semibold text-white">Recent Sessions</h2>
          <Link to="/admin/sessions" className="text-gold-400 hover:text-gold-300 text-sm">
            View all →
          </Link>
        </div>
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-navy-700">
              <th className="px-6 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Advisor</th>
              <th className="px-4 py-3 font-medium">Score</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-700">
            {recentSessions.map((s) => (
              <tr key={s.id} className="hover:bg-navy-700/50 transition-colors">
                <td className="px-6 py-3 text-slate-400 text-sm">{formatDate(s.started_at)}</td>
                <td className="px-4 py-3 text-white text-sm font-medium">{s.client_name}</td>
                <td className="px-4 py-3 text-slate-400 text-sm">{s.advisor_name ?? '—'}</td>
                <td className="px-4 py-3"><ScoreBadge score={s.overall_score} /></td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                    s.status === 'completed' ? 'bg-green-900/50 text-green-400' : s.status === 'active' ? 'bg-blue-900/50 text-blue-400' : 'bg-red-900/50 text-red-400'
                  }`}>{s.status}</span>
                </td>
                <td className="px-4 py-3">
                  <Link to={`/sessions/${s.id}`} className="text-gold-400 hover:text-gold-300 text-sm">View →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
