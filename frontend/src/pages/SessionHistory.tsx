import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { sessionsApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import PersonaBadge from '../components/PersonaBadge';
import type { SessionPublic } from '../types';
import { getErrorMessage } from '../utils/errors';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(start: string, end: string | null) {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}

function ScoreBadge({ score, max = 10 }: { score: number | null | undefined; max?: number }) {
  if (score == null) return <span className="text-slate-500 text-sm">—</span>;
  const pct = score / max;
  const cls =
    pct >= 0.8 ? 'bg-green-900 text-green-300' : pct >= 0.5 ? 'bg-yellow-900 text-yellow-300' : 'bg-red-900 text-red-300';
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{score.toFixed(1)}/{max}</span>;
}

export default function SessionHistory() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [advisorFilter, setAdvisorFilter] = useState('');

  useEffect(() => {
    sessionsApi
      .list()
      .then(setSessions)
      .catch((err) => toast.error(`Failed to load sessions: ${getErrorMessage(err)}`))
      .finally(() => setLoading(false));
  }, [toast]);

  const advisorNames = isAdmin
    ? [...new Set(sessions.map((s) => s.advisor_name).filter(Boolean))]
    : [];

  const filtered = sessions.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (dateFrom && new Date(s.started_at) < new Date(dateFrom)) return false;
    if (dateTo && new Date(s.started_at) > new Date(dateTo + 'T23:59:59')) return false;
    // Filter on a normalized 0–10 score so the min/max inputs behave the
    // same way regardless of whether a session was scored 1–5 or 1–10.
    const normalized =
      s.overall_score != null ? s.overall_score * (10 / (s.score_scale ?? 10)) : null;
    if (minScore && (normalized ?? -1) < parseFloat(minScore)) return false;
    if (maxScore && (normalized ?? 11) > parseFloat(maxScore)) return false;
    if (advisorFilter && s.advisor_name !== advisorFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Session History</h1>
          <p className="text-slate-500 mt-1">
            {isAdmin ? 'All advisor training sessions' : 'Your training sessions'}
          </p>
        </div>
        <Link
          to="/sessions/new"
          className="inline-flex items-center gap-2 bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg text-sm transition-colors"
        >
          + New Session
        </Link>
      </div>

      {/* Filters */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 mb-6 flex flex-wrap gap-3 items-end">
        {/* Status */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="error">Error</option>
          </select>
        </div>

        {/* Date From */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Date From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>

        {/* Date To */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Date To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>

        {/* Score range */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Min Score</label>
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            placeholder="0"
            className="w-20 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Max Score</label>
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={maxScore}
            onChange={(e) => setMaxScore(e.target.value)}
            placeholder="10"
            className="w-20 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>

        {/* Advisor filter (admin only) */}
        {isAdmin && advisorNames.length > 0 && (
          <div>
            <label className="block text-xs text-slate-500 mb-1">Advisor</label>
            <select
              value={advisorFilter}
              onChange={(e) => setAdvisorFilter(e.target.value)}
              className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            >
              <option value="">All Advisors</option>
              {advisorNames.map((name) => (
                <option key={name} value={name ?? ''}>{name}</option>
              ))}
            </select>
          </div>
        )}

        <button
          onClick={() => { setStatusFilter('all'); setDateFrom(''); setDateTo(''); setMinScore(''); setMaxScore(''); setAdvisorFilter(''); }}
          className="text-slate-500 hover:text-slate-300 text-sm transition-colors ml-auto"
        >
          Clear Filters
        </button>
      </div>

      {/* Table */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
        <div className="px-6 py-3 border-b border-navy-700 text-sm text-slate-500">
          {sorted.length} session{sorted.length !== 1 ? 's' : ''} found
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <svg className="animate-spin h-8 w-8 text-gold-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-16 text-slate-500">No sessions match your filters</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-navy-700">
                <th className="px-6 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Client</th>
                {isAdmin && <th className="px-4 py-3 font-medium">Advisor</th>}
                <th className="px-4 py-3 font-medium">Persona</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {sorted.map((session) => (
                <tr key={session.id} className="hover:bg-navy-700/50 transition-colors">
                  <td className="px-6 py-3 text-slate-400 text-sm whitespace-nowrap">
                    {formatDate(session.started_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-navy-700 flex items-center justify-center text-xs text-slate-400 flex-shrink-0">
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
