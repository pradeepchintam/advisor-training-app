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

  // Split into two sections per spec: admin-assigned vs self-initiated.
  const assignedSessions = sorted.filter(
    (s) => (s.source ?? 'self_initiated') === 'assigned',
  );
  const selfInitiatedSessions = sorted.filter(
    (s) => (s.source ?? 'self_initiated') === 'self_initiated',
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

      {/* Two sections: admin-assigned and self-initiated */}
      {loading ? (
        <div className="bg-navy-800 border border-navy-700 rounded-xl flex items-center justify-center py-16">
          <svg className="animate-spin h-8 w-8 text-gold-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : (
        <>
          <SessionSection
            title="Admin-Assigned Sessions"
            subtitle="Sessions advisors ran from a profile you assigned to them."
            accent="gold"
            sessions={assignedSessions}
            flagged={flagged}
            notes={notes}
            editingNote={editingNote}
            noteInput={noteInput}
            onToggleFlag={toggleFlag}
            onStartEditNote={(id) => { setEditingNote(id); setNoteInput(notes[id] || ''); }}
            onChangeNote={setNoteInput}
            onSaveNote={saveNote}
            onCancelNote={() => setEditingNote(null)}
          />
          <div className="h-6" />
          <SessionSection
            title="Self-Initiated Sessions"
            subtitle="Sessions advisors started on their own outside of any assignment."
            accent="slate"
            sessions={selfInitiatedSessions}
            flagged={flagged}
            notes={notes}
            editingNote={editingNote}
            noteInput={noteInput}
            onToggleFlag={toggleFlag}
            onStartEditNote={(id) => { setEditingNote(id); setNoteInput(notes[id] || ''); }}
            onChangeNote={setNoteInput}
            onSaveNote={saveNote}
            onCancelNote={() => setEditingNote(null)}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section + row helpers
// ---------------------------------------------------------------------------

interface SessionSectionProps {
  title: string;
  subtitle: string;
  accent: 'gold' | 'slate';
  sessions: SessionPublic[];
  flagged: Set<string>;
  notes: Record<string, string>;
  editingNote: string | null;
  noteInput: string;
  onToggleFlag: (id: string) => void;
  onStartEditNote: (id: string) => void;
  onChangeNote: (text: string) => void;
  onSaveNote: (id: string) => void;
  onCancelNote: () => void;
}

function SessionSection({
  title, subtitle, accent, sessions, flagged, notes,
  editingNote, noteInput,
  onToggleFlag, onStartEditNote, onChangeNote, onSaveNote, onCancelNote,
}: SessionSectionProps) {
  const accentClass = accent === 'gold' ? 'border-gold-500/30' : 'border-navy-700';
  const headerColor = accent === 'gold' ? 'text-gold-400' : 'text-slate-300';
  return (
    <div className={`bg-navy-800 border ${accentClass} rounded-xl overflow-hidden`}>
      <div className="px-6 py-4 border-b border-navy-700 flex items-center justify-between">
        <div>
          <h2 className={`font-semibold ${headerColor}`}>{title}</h2>
          <p className="text-slate-500 text-xs mt-0.5">{subtitle}</p>
        </div>
        <span className="text-xs text-slate-500">
          {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          {accent === 'gold'
            ? 'No admin-assigned sessions match your filters yet.'
            : 'No self-initiated sessions match your filters.'}
        </div>
      ) : (
        <div className="divide-y divide-navy-700">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              flagged={flagged.has(session.id)}
              note={notes[session.id]}
              isEditingNote={editingNote === session.id}
              noteInput={noteInput}
              onToggleFlag={() => onToggleFlag(session.id)}
              onStartEditNote={() => onStartEditNote(session.id)}
              onChangeNote={onChangeNote}
              onSaveNote={() => onSaveNote(session.id)}
              onCancelNote={onCancelNote}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  session: SessionPublic;
  flagged: boolean;
  note?: string;
  isEditingNote: boolean;
  noteInput: string;
  onToggleFlag: () => void;
  onStartEditNote: () => void;
  onChangeNote: (text: string) => void;
  onSaveNote: () => void;
  onCancelNote: () => void;
}

function SessionRow({
  session, flagged, note, isEditingNote, noteInput,
  onToggleFlag, onStartEditNote, onChangeNote, onSaveNote, onCancelNote,
}: SessionRowProps) {
  return (
    <div className={`p-5 hover:bg-navy-700/30 transition-colors ${flagged ? 'border-l-2 border-red-500' : ''}`}>
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-full bg-navy-700 flex items-center justify-center text-sm text-gold-400 font-bold flex-shrink-0 mt-0.5">
          {session.client_name?.[0] ?? '?'}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <span className="text-white font-semibold">{session.client_name}</span>
            {(session.source ?? 'self_initiated') === 'assigned' && session.profile_name && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-gold-500/10 text-gold-300 border border-gold-500/40"
                title={`Assigned from profile: ${session.profile_name}`}
              >
                ★ {session.profile_name}
              </span>
            )}
            <span className="text-slate-500 text-sm">·</span>
            <span className="text-slate-400 text-sm">{session.advisor_name ?? 'Unknown Advisor'}</span>
            <span className="text-slate-500 text-sm">·</span>
            <span className="text-slate-500 text-sm">{formatDate(session.started_at)}</span>
          </div>

          <div className="flex items-center gap-3 mb-2">
            <PersonaBadge persona={session.persona} compact />
            <span className="text-slate-600 text-xs">{formatDuration(session.started_at, session.ended_at)}</span>
          </div>

          {isEditingNote ? (
            <div className="flex gap-2 mt-2">
              <input
                value={noteInput}
                onChange={(e) => onChangeNote(e.target.value)}
                placeholder="Add note..."
                className="flex-1 bg-navy-900 border border-navy-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-gold-500"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') onSaveNote(); }}
              />
              <button onClick={onSaveNote} className="text-green-400 hover:text-green-300 text-xs font-medium">Save</button>
              <button onClick={onCancelNote} className="text-slate-500 hover:text-slate-300 text-xs">Cancel</button>
            </div>
          ) : note ? (
            <div
              className="mt-1 text-xs text-slate-400 italic cursor-pointer hover:text-slate-300"
              onClick={onStartEditNote}
            >
              📝 {note}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <ScoreBadge score={session.overall_score} />
          <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
            session.status === 'completed' ? 'bg-green-900/50 text-green-400' : session.status === 'active' ? 'bg-blue-900/50 text-blue-400' : 'bg-red-900/50 text-red-400'
          }`}>{session.status}</span>

          <button
            onClick={onToggleFlag}
            title={flagged ? 'Remove flag' : 'Flag session'}
            className={`text-sm transition-colors ${flagged ? 'text-red-400 hover:text-red-300' : 'text-slate-600 hover:text-red-400'}`}
          >
            ⚑
          </button>

          <button
            onClick={onStartEditNote}
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
  );
}
