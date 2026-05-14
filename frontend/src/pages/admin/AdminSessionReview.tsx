import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { sessionsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import PersonaBadge from '../../components/PersonaBadge';
import type { SessionPublic } from '../../types';
import { getErrorMessage } from '../../utils/errors';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(start: string, end: string | null) {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}

function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-slate-500 text-sm">—</span>;
  const cls =
    score >= 8 ? 'bg-green-900 text-green-300' : score >= 5 ? 'bg-yellow-900 text-yellow-300' : 'bg-red-900 text-red-300';
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{score.toFixed(1)}</span>;
}

export default function AdminSessionReview() {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [advisorFilter, setAdvisorFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteInput, setNoteInput] = useState('');

  useEffect(() => {
    sessionsApi
      .list()
      .then(setSessions)
      .catch((err) => toast.error(`Failed to load sessions: ${getErrorMessage(err)}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advisorNames = [...new Set(sessions.map((s) => s.advisor_name).filter(Boolean))];

  const filtered = sessions.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (advisorFilter && s.advisor_name !== advisorFilter) return false;
    if (dateFrom && new Date(s.started_at) < new Date(dateFrom)) return false;
    if (dateTo && new Date(s.started_at) > new Date(dateTo + 'T23:59:59')) return false;
    return true;
  });

  const sorted = [...filtered].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  const toggleFlag = (id: string) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveNote = (id: string) => {
    setNotes((prev) => ({ ...prev, [id]: noteInput }));
    setEditingNote(null);
    setNoteInput('');
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Review All Sessions</h1>
          <p className="text-slate-500 mt-1">Admin view of all training sessions across advisors</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 mb-6 flex flex-wrap gap-3 items-end">
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

        <div>
          <label className="block text-xs text-slate-500 mb-1">Advisor</label>
          <select
            value={advisorFilter}
            onChange={(e) => setAdvisorFilter(e.target.value)}
            className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          >
            <option value="">All Advisors</option>
            {advisorNames.map((n) => (
              <option key={n} value={n ?? ''}>{n}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>

        <button
          onClick={() => { setStatusFilter('all'); setAdvisorFilter(''); setDateFrom(''); setDateTo(''); }}
          className="text-slate-500 hover:text-slate-300 text-sm transition-colors ml-auto"
        >
          Clear Filters
        </button>
      </div>

      {/* Sessions Table */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
        <div className="px-6 py-3 border-b border-navy-700 flex items-center justify-between">
          <span className="text-sm text-slate-500">{sorted.length} sessions</span>
          <span className="text-xs text-slate-600">
            {flagged.size > 0 && `${flagged.size} flagged`}
          </span>
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
          <div className="divide-y divide-navy-700">
            {sorted.map((session) => (
              <div key={session.id} className={`p-5 hover:bg-navy-700/30 transition-colors ${flagged.has(session.id) ? 'border-l-2 border-red-500' : ''}`}>
                <div className="flex items-start gap-4">
                  {/* Client avatar */}
                  <div className="w-10 h-10 rounded-full bg-navy-700 flex items-center justify-center text-sm text-gold-400 font-bold flex-shrink-0 mt-0.5">
                    {session.client_name?.[0] ?? '?'}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-white font-semibold">{session.client_name}</span>
                      <span className="text-slate-500 text-sm">·</span>
                      <span className="text-slate-400 text-sm">{session.advisor_name ?? 'Unknown Advisor'}</span>
                      <span className="text-slate-500 text-sm">·</span>
                      <span className="text-slate-500 text-sm">{formatDate(session.started_at)}</span>
                    </div>

                    <div className="flex items-center gap-3 mb-2">
                      <PersonaBadge persona={session.persona} compact />
                      <span className="text-slate-600 text-xs">{formatDuration(session.started_at, session.ended_at)}</span>
                    </div>

                    {/* Note */}
                    {editingNote === session.id ? (
                      <div className="flex gap-2 mt-2">
                        <input
                          value={noteInput}
                          onChange={(e) => setNoteInput(e.target.value)}
                          placeholder="Add note..."
                          className="flex-1 bg-navy-900 border border-navy-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-gold-500"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === 'Enter') saveNote(session.id); }}
                        />
                        <button onClick={() => saveNote(session.id)} className="text-green-400 hover:text-green-300 text-xs font-medium">Save</button>
                        <button onClick={() => setEditingNote(null)} className="text-slate-500 hover:text-slate-300 text-xs">Cancel</button>
                      </div>
                    ) : notes[session.id] ? (
                      <div
                        className="mt-1 text-xs text-slate-400 italic cursor-pointer hover:text-slate-300"
                        onClick={() => { setEditingNote(session.id); setNoteInput(notes[session.id]); }}
                      >
                        📝 {notes[session.id]}
                      </div>
                    ) : null}
                  </div>

                  {/* Right actions */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <ScoreBadge score={session.overall_score} />
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      session.status === 'completed' ? 'bg-green-900/50 text-green-400' : session.status === 'active' ? 'bg-blue-900/50 text-blue-400' : 'bg-red-900/50 text-red-400'
                    }`}>{session.status}</span>

                    <button
                      onClick={() => toggleFlag(session.id)}
                      title={flagged.has(session.id) ? 'Remove flag' : 'Flag session'}
                      className={`text-sm transition-colors ${flagged.has(session.id) ? 'text-red-400 hover:text-red-300' : 'text-slate-600 hover:text-red-400'}`}
                    >
                      ⚑
                    </button>

                    <button
                      onClick={() => { setEditingNote(session.id); setNoteInput(notes[session.id] || ''); }}
                      title="Add note"
                      className="text-slate-600 hover:text-gold-400 text-sm transition-colors"
                    >
                      📝
                    </button>

                    <Link
                      to={`/sessions/${session.id}`}
                      className="text-gold-400 hover:text-gold-300 text-sm transition-colors font-medium"
                    >
                      View →
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
