import React, { useEffect, useState } from 'react';
import { presentationsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import { getErrorMessage } from '../../utils/errors';
import type { Presentation } from '../../types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function PresentationManagement() {
  const toast = useToast();
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      setPresentations(await presentationsApi.list());
    } catch (err: unknown) {
      toast.error(`Failed to load presentations: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async () => {
    if (!file) { toast.error('Pick a .pptx file first'); return; }
    if (!title.trim()) { toast.error('Title is required'); return; }
    setUploading(true);
    try {
      await presentationsApi.upload(title.trim(), file);
      toast.success('Presentation uploaded and activated');
      setFile(null); setTitle('');
      (document.getElementById('pptx-input') as HTMLInputElement | null)?.value && ((document.getElementById('pptx-input') as HTMLInputElement).value = '');
      await refresh();
    } catch (err: unknown) {
      toast.error(`Upload failed: ${getErrorMessage(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await presentationsApi.activate(id);
      toast.success('Activated');
      await refresh();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this presentation? This cannot be undone.')) return;
    try {
      await presentationsApi.delete(id);
      toast.success('Deleted');
      await refresh();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-1">Presentations</h1>
      <p className="text-slate-400 mb-6">Upload the slide deck advisors walk clients through during sessions. Only one version is active at a time.</p>

      {/* Upload card */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-5 mb-6">
        <h2 className="text-lg font-semibold text-white mb-3">Upload new version</h2>
        <div className="grid md:grid-cols-3 gap-3 items-end">
          <div className="md:col-span-1">
            <label className="block text-xs text-slate-400 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q2 2026 Client Discovery Deck"
              className="w-full bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-xs text-slate-400 mb-1">.pptx file</label>
            <input
              id="pptx-input"
              type="file"
              accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-slate-300 text-sm file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-navy-700 file:text-slate-200 hover:file:bg-navy-600"
            />
          </div>
          <button
            onClick={handleUpload}
            disabled={uploading || !file || !title.trim()}
            className="bg-gold-500 hover:bg-gold-400 disabled:bg-navy-700 disabled:text-slate-500 text-navy-900 font-semibold px-5 py-2 rounded-lg transition-colors"
          >
            {uploading ? 'Uploading…' : 'Upload + activate'}
          </button>
        </div>
        <p className="text-slate-500 text-xs mt-3">Conversion to slide images can take ~30 seconds for large decks.</p>
      </div>

      {/* List */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl">
        <div className="px-5 py-3 border-b border-navy-700">
          <h2 className="text-lg font-semibold text-white">Versions</h2>
        </div>
        {loading ? (
          <div className="p-6 text-slate-400 text-sm">Loading…</div>
        ) : presentations.length === 0 ? (
          <div className="p-6 text-slate-400 text-sm">No presentations uploaded yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-5 py-2.5">Version</th>
                <th className="text-left px-5 py-2.5">Title</th>
                <th className="text-left px-5 py-2.5">Slides</th>
                <th className="text-left px-5 py-2.5">Uploaded</th>
                <th className="text-left px-5 py-2.5">Status</th>
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {presentations.map((p) => (
                <tr key={p.id} className="border-t border-navy-700 hover:bg-navy-900/40">
                  <td className="px-5 py-3 text-slate-300">v{p.version}</td>
                  <td className="px-5 py-3 text-white">{p.title}</td>
                  <td className="px-5 py-3 text-slate-400">{p.slide_count}</td>
                  <td className="px-5 py-3 text-slate-500">{formatDate(p.created_at)}</td>
                  <td className="px-5 py-3">
                    {p.is_active ? (
                      <span className="inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-green-900 text-green-300">Active</span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-navy-700 text-slate-400">Archived</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right space-x-2">
                    {!p.is_active && (
                      <button
                        onClick={() => handleActivate(p.id)}
                        className="text-gold-400 hover:text-gold-300 text-xs"
                      >Activate</button>
                    )}
                    {!p.is_active && (
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >Delete</button>
                    )}
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
