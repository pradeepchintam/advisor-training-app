import React, { useEffect, useState } from 'react';
import { scriptsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import { getErrorMessage } from '../../utils/errors';
import type { TrainingScript } from '../../types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const STARTER = `# Discovery Call Script

## Opening (2 min)
- Greet the client warmly
- Confirm the meeting purpose
- Ask permission to record

## Financial Discovery (10 min)
- Current employment and income
- Existing investments
- Retirement plans
- Major life goals

## Walk through the deck
- Slide 1: Firm intro
- Slide 2: Fiduciary commitment
- Slide 3: Discovery framework

## Closing (3 min)
- Recap what you heard
- Set up the next meeting
`;

export default function ScriptEditor() {
  const toast = useToast();
  const [scripts, setScripts] = useState<TrainingScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await scriptsApi.list();
      setScripts(list);
      // Preload editor with the active version's content (or starter)
      const active = list.find((s) => s.is_active);
      if (active && !content) {
        setTitle(active.title);
        setContent(active.content);
      } else if (!content) {
        setContent(STARTER);
      }
    } catch (err: unknown) {
      toast.error(`Failed to load scripts: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!content.trim()) { toast.error('Content is required'); return; }
    setSaving(true);
    try {
      await scriptsApi.create({ title: title.trim() || `Version ${(scripts[0]?.version ?? 0) + 1}`, content });
      toast.success('Saved as new version and activated');
      await refresh();
    } catch (err: unknown) {
      toast.error(`Save failed: ${getErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const loadVersion = (s: TrainingScript) => {
    setTitle(s.title);
    setContent(s.content);
  };

  const handleActivate = async (id: string) => {
    try {
      await scriptsApi.activate(id);
      toast.success('Activated');
      await refresh();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this script version? This cannot be undone.')) return;
    try {
      await scriptsApi.delete(id);
      toast.success('Deleted');
      await refresh();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-1">Training Script</h1>
      <p className="text-slate-400 mb-6">Write the script you want advisors to follow during sessions. Markdown is supported. The active version is used to grade advisor adherence at session end.</p>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Editor */}
        <div className="md:col-span-2 bg-navy-800 border border-navy-700 rounded-xl p-5">
          <div className="mb-3">
            <label className="block text-xs text-slate-400 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Discovery Call v2"
              className="w-full bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            />
          </div>
          <div className="mb-3">
            <label className="block text-xs text-slate-400 mb-1">Markdown content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={22}
              className="w-full bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-gold-500"
            />
          </div>
          <button
            onClick={handleSave}
            disabled={saving || !content.trim()}
            className="bg-gold-500 hover:bg-gold-400 disabled:bg-navy-700 disabled:text-slate-500 text-navy-900 font-semibold px-5 py-2 rounded-lg transition-colors"
          >
            {saving ? 'Saving…' : 'Save as new version'}
          </button>
        </div>

        {/* Version list */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl">
          <div className="px-4 py-3 border-b border-navy-700">
            <h2 className="text-sm font-semibold text-white">Versions</h2>
          </div>
          {loading ? (
            <div className="p-4 text-slate-400 text-sm">Loading…</div>
          ) : scripts.length === 0 ? (
            <div className="p-4 text-slate-400 text-sm">No versions yet — save above to create v1.</div>
          ) : (
            <ul className="divide-y divide-navy-700">
              {scripts.map((s) => (
                <li key={s.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm font-medium truncate">v{s.version} · {s.title}</div>
                      <div className="text-xs text-slate-500">{formatDate(s.created_at)}</div>
                    </div>
                    {s.is_active && (
                      <span className="inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-green-900 text-green-300 ml-2">Active</span>
                    )}
                  </div>
                  <div className="mt-2 space-x-3 text-xs">
                    <button onClick={() => loadVersion(s)} className="text-slate-300 hover:text-white">Load into editor</button>
                    {!s.is_active && (
                      <button onClick={() => handleActivate(s.id)} className="text-gold-400 hover:text-gold-300">Activate</button>
                    )}
                    {!s.is_active && (
                      <button onClick={() => handleDelete(s.id)} className="text-red-400 hover:text-red-300">Delete</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
