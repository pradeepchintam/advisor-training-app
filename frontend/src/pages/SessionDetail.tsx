import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { sessionsApi } from '../services/api';
import { useToast } from '../components/Toast';
import ScoreGauge from '../components/ScoreGauge';
import PersonaBadge from '../components/PersonaBadge';
import type { SessionDetail as SessionDetailType, SessionAnalysis } from '../types';
import { getErrorMessage } from '../utils/errors';

type Tab = 'analysis' | 'transcript' | 'recording';

function CategoryBar({
  label,
  score,
  feedback,
}: {
  label: string;
  score: number;
  feedback: string;
}) {
  const color =
    score >= 8 ? 'bg-green-500' : score >= 5 ? 'bg-yellow-500' : 'bg-red-500';
  const textColor =
    score >= 8 ? 'text-green-400' : score >= 5 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-slate-300">{label}</span>
        <span className={`text-sm font-bold ${textColor}`}>{score.toFixed(1)}/10</span>
      </div>
      <div className="h-2 bg-navy-900 rounded-full overflow-hidden mb-1.5">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${(score / 10) * 100}%` }}
        />
      </div>
      {feedback && <p className="text-slate-500 text-xs leading-relaxed">{feedback}</p>}
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: string, end: string | null) {
  if (!end) return 'In progress';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [session, setSession] = useState<SessionDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('analysis');
  const [reanalyzing, setReanalyzing] = useState(false);

  const loadSession = () => {
    if (!id) return;
    setLoading(true);
    sessionsApi
      .get(id)
      .then(setSession)
      .catch((err) => toast.error(`Failed to load session: ${getErrorMessage(err)}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadSession();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReanalyze = async () => {
    if (!id) return;
    setReanalyzing(true);
    try {
      await sessionsApi.end(id);
      toast.success('Re-analysis triggered. Refreshing...');
      setTimeout(loadSession, 3000);
    } catch (err) {
      toast.error(`Re-analysis failed: ${getErrorMessage(err)}`);
    } finally {
      setReanalyzing(false);
    }
  };

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

  if (!session) {
    return (
      <div className="p-8 text-center">
        <div className="text-slate-500">Session not found</div>
        <Link to="/sessions" className="text-gold-400 hover:text-gold-300 mt-2 inline-block">
          ← Back to sessions
        </Link>
      </div>
    );
  }

  const analysis: SessionAnalysis | null = session.analysis;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-4 mb-3">
          <Link to="/dashboard" className="text-slate-500 hover:text-slate-300 text-sm transition-colors">
            ← Dashboard
          </Link>
          <span className="text-slate-700">·</span>
          <Link to="/sessions" className="text-slate-500 hover:text-slate-300 text-sm transition-colors">
            Session History
          </Link>
        </div>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{session.client_name}</h1>
            <p className="text-slate-500 mt-1">{formatDate(session.started_at)}</p>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-slate-500 text-sm">
                Duration: {formatDuration(session.started_at, session.ended_at)}
              </span>
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
            </div>
          </div>
          {analysis && (
            <div className="text-center">
              <ScoreGauge score={analysis.overall_score} size={100} />
              <div className="text-slate-500 text-xs mt-1">Overall Score</div>
            </div>
          )}
        </div>
        {session.persona && (
          <div className="mt-3">
            <PersonaBadge persona={session.persona} />
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-navy-900 rounded-lg p-1 w-fit">
        {(['analysis', 'transcript', 'recording'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors capitalize ${
              tab === t
                ? 'bg-navy-800 text-white shadow'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Analysis Tab */}
      {tab === 'analysis' && (
        <div>
          {!analysis && session.status === 'active' && (
            <div className="bg-navy-800 border border-navy-700 rounded-xl p-8 text-center">
              <div className="text-slate-500 mb-4">Session is still active. End the session to generate analysis.</div>
              <Link
                to={`/sessions/${id}`}
                className="inline-flex items-center gap-2 bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg text-sm"
              >
                Return to Session
              </Link>
            </div>
          )}

          {!analysis && session.status === 'completed' && (
            <div className="bg-navy-800 border border-navy-700 rounded-xl p-8 text-center">
              <div className="text-slate-500 mb-4">Analysis is being generated. This may take a moment...</div>
              <button
                onClick={loadSession}
                className="bg-navy-700 hover:bg-navy-600 text-white px-4 py-2 rounded-lg text-sm"
              >
                Refresh
              </button>
            </div>
          )}

          {analysis && (
            <div className="space-y-6">
              {/* Overall score + summary */}
              <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
                <div className="flex items-center gap-6">
                  <ScoreGauge score={analysis.overall_score} size={140} />
                  <div className="flex-1">
                    <h2 className="text-lg font-semibold text-white mb-2">Session Summary</h2>
                    <p className="text-slate-400 text-sm leading-relaxed">{analysis.transcript_summary}</p>
                  </div>
                </div>
              </div>

              {/* Category scores */}
              <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
                <h2 className="font-semibold text-white mb-5">Performance Categories</h2>
                <CategoryBar label="Rapport Building" score={analysis.categories.rapport_building.score} feedback={analysis.categories.rapport_building.feedback} />
                <CategoryBar label="Financial Discovery" score={analysis.categories.financial_discovery.score} feedback={analysis.categories.financial_discovery.feedback} />
                <CategoryBar label="Needs Analysis" score={analysis.categories.needs_analysis.score} feedback={analysis.categories.needs_analysis.feedback} />
                <CategoryBar label="Product Knowledge" score={analysis.categories.product_knowledge.score} feedback={analysis.categories.product_knowledge.feedback} />
                <CategoryBar label="Compliance Adherence" score={analysis.categories.compliance_adherence.score} feedback={analysis.categories.compliance_adherence.feedback} />
                <CategoryBar label="Communication Skills" score={analysis.categories.communication_skills.score} feedback={analysis.categories.communication_skills.feedback} />
                <CategoryBar label="Closing Skills" score={analysis.categories.closing_skills.score} feedback={analysis.categories.closing_skills.feedback} />
              </div>

              {/* Strengths & Improvements */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
                  <h3 className="font-semibold text-green-400 mb-3 flex items-center gap-2">
                    <span>✓</span> Strengths
                  </h3>
                  <ul className="space-y-2">
                    {analysis.strengths.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                        <span className="text-green-500 mt-0.5 flex-shrink-0">✓</span>
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
                  <h3 className="font-semibold text-orange-400 mb-3 flex items-center gap-2">
                    <span>↑</span> Areas for Improvement
                  </h3>
                  <ul className="space-y-2">
                    {analysis.areas_for_improvement.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                        <span className="text-orange-500 mt-0.5 flex-shrink-0">→</span>
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Compliance Flags */}
              {analysis.compliance_flags?.length > 0 && (
                <div className="bg-red-950 border border-red-800 rounded-xl p-5">
                  <h3 className="font-semibold text-red-400 mb-3 flex items-center gap-2">
                    <span>⚠</span> Compliance Flags
                  </h3>
                  <ul className="space-y-2">
                    {analysis.compliance_flags.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-red-300">
                        <span className="text-red-500 mt-0.5 flex-shrink-0">⚠</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Recommendations */}
              {analysis.recommendations?.length > 0 && (
                <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
                  <h3 className="font-semibold text-blue-400 mb-3">Recommendations</h3>
                  <ol className="space-y-2 list-decimal list-inside">
                    {analysis.recommendations.map((r, i) => (
                      <li key={i} className="text-sm text-slate-300 leading-relaxed">{r}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Transcript Tab */}
      {tab === 'transcript' && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          {session.conversation?.length > 0 ? (
            <div className="space-y-4">
              {session.conversation.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'advisor' ? 'flex-row-reverse' : ''}`}>
                  <div
                    className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                      msg.role === 'client' ? 'bg-navy-700 text-gold-400' : 'bg-gold-500 text-navy-900'
                    }`}
                  >
                    {msg.role === 'client' ? session.client_name?.[0] ?? 'C' : 'A'}
                  </div>
                  <div className={`max-w-2xl ${msg.role === 'advisor' ? 'items-end' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-slate-500">
                        {msg.role === 'client' ? session.client_name : 'You (Advisor)'}
                      </span>
                      <span className="text-xs text-slate-600">{formatTime(msg.timestamp)}</span>
                    </div>
                    <div
                      className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'client'
                          ? 'bg-navy-900 text-slate-200 rounded-tl-sm'
                          : 'bg-gold-500/20 border border-gold-500/30 text-white rounded-tr-sm'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-slate-500 py-8">No transcript available</div>
          )}
        </div>
      )}

      {/* Recording Tab */}
      {tab === 'recording' && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <h3 className="font-semibold text-white mb-4">Session Recording</h3>
          <video
            src={sessionsApi.getRecordingUrl(session.id)}
            controls
            preload="metadata"
            className="w-full rounded-lg bg-black mb-4"
            style={{ maxHeight: '400px' }}
            onError={(e) => {
              const v = e.currentTarget;
              const err = v.error;
              const codes: Record<number, string> = {
                1: 'Aborted',
                2: 'Network error — could not load recording',
                3: 'Decode error — recording file may be corrupted',
                4: 'Source not supported — file missing, deleted, or auth failed',
              };
              const reason = err ? codes[err.code] || `code ${err.code}` : 'unknown';
              toast.error(`Recording playback failed: ${reason}${err?.message ? ` (${err.message})` : ''}`);
            }}
          >
            Your browser does not support playback.
          </video>
          <div className="flex gap-3">
            <a
              href={sessionsApi.getRecordingUrl(session.id)}
              download={`session-${session.id}.webm`}
              className="inline-flex items-center gap-2 bg-navy-700 hover:bg-navy-600 text-white px-4 py-2 rounded-lg text-sm transition-colors"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              Download Recording
            </a>
            <button
              onClick={handleReanalyze}
              disabled={reanalyzing}
              className="inline-flex items-center gap-2 bg-gold-500/10 hover:bg-gold-500/20 border border-gold-500/30 text-gold-400 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              {reanalyzing ? 'Re-analyzing...' : 'Re-analyze Session'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
