import { useEffect, useRef, useState } from 'react';
import { presentationsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import { getErrorMessage } from '../../utils/errors';
import type { DeckSlot, Presentation } from '../../types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const SLOTS: { slot: DeckSlot; label: string; blurb: string }[] = [
  { slot: 'first', label: 'First Appointment', blurb: 'Shown for 1st AUM appointments.' },
  { slot: 'second', label: 'Second Appointment', blurb: 'Shown for 2nd AUM appointments.' },
  { slot: 'third_annuity', label: 'Third · Annuity', blurb: 'Shown (with Private Equity) for 3rd appointments.' },
  { slot: 'third_private_equity', label: 'Third · Private Equity', blurb: 'Shown (with Annuity) for 3rd appointments.' },
];

export default function PresentationManagement() {
  const toast = useToast();
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-1">Presentations &amp; Scripts</h1>
      <p className="text-slate-400 mb-6">
        Upload a slide deck + its PDF script for each appointment type. The session shows the deck
        matching the assigned appointment, and the advisor is graded on that deck's script. Third
        appointments show <span className="text-gold-400">both</span> the Annuity and Private Equity
        decks. One version is active per appointment type.
      </p>

      {loading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="space-y-6">
          {SLOTS.map((s) => (
            <SlotSection
              key={s.slot}
              slot={s.slot}
              label={s.label}
              blurb={s.blurb}
              presentations={presentations.filter((p) => (p.slot ?? 'first') === s.slot)}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SlotSection({
  slot, label, blurb, presentations, onChanged,
}: {
  slot: DeckSlot;
  label: string;
  blurb: string;
  presentations: Presentation[];
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [pptFiles, setPptFiles] = useState<File[]>([]);
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scriptRef = useRef<HTMLInputElement | null>(null);

  const active = presentations.find((p) => p.is_active);
  const totalPptBytes = pptFiles.reduce((sum, f) => sum + f.size, 0);

  const resetForm = () => {
    setTitle(''); setPptFiles([]); setScriptFile(null);
    if (fileRef.current) fileRef.current.value = '';
    if (scriptRef.current) scriptRef.current.value = '';
  };

  const removePpt = (index: number) => {
    setPptFiles((files) => files.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (!title.trim()) { toast.error(`${label}: enter a title`); return; }
    if (pptFiles.length === 0) { toast.error(`${label}: pick at least one .pptx file`); return; }
    const bad = pptFiles.find((f) => !f.name.toLowerCase().endsWith('.pptx'));
    if (bad) {
      toast.error(`Only .pptx files are supported (got ${bad.name})`);
      return;
    }
    if (totalPptBytes > 150 * 1024 * 1024) {
      toast.error(`Total size ${(totalPptBytes / 1024 / 1024).toFixed(1)} MB exceeds the 150 MB cap`);
      return;
    }
    if (scriptFile && !scriptFile.name.toLowerCase().endsWith('.pdf')) {
      toast.error('The script must be a .pdf file');
      return;
    }
    setUploading(true);
    try {
      await presentationsApi.upload(title.trim(), pptFiles, scriptFile, slot);
      const fileSummary = pptFiles.length > 1 ? ` (${pptFiles.length} files merged)` : '';
      toast.success(`${label}: uploaded${fileSummary}${scriptFile ? ' + script' : ''} and activated`);
      resetForm();
      await onChanged();
    } catch (err: unknown) {
      toast.error(`Upload failed: ${getErrorMessage(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async (id: string) => {
    try { await presentationsApi.activate(id); toast.success('Activated'); await onChanged(); }
    catch (err: unknown) { toast.error(getErrorMessage(err)); }
  };
  const handleDelete = async (id: string) => {
    if (!confirm('Delete this version? This cannot be undone.')) return;
    try { await presentationsApi.delete(id); toast.success('Deleted'); await onChanged(); }
    catch (err: unknown) { toast.error(getErrorMessage(err)); }
  };
  const handleAttachScript = async (id: string, f: File) => {
    if (!f.name.toLowerCase().endsWith('.pdf')) { toast.error('Script must be a .pdf'); return; }
    setBusyRow(id);
    try { await presentationsApi.attachScript(id, f); toast.success('Script attached'); await onChanged(); }
    catch (err: unknown) { toast.error(`Failed: ${getErrorMessage(err)}`); }
    finally { setBusyRow(null); }
  };
  const handleRemoveScript = async (id: string) => {
    if (!confirm('Remove the attached script?')) return;
    setBusyRow(id);
    try { await presentationsApi.removeScript(id); toast.success('Script removed'); await onChanged(); }
    catch (err: unknown) { toast.error(getErrorMessage(err)); }
    finally { setBusyRow(null); }
  };
  const handleViewScript = async (id: string) => {
    try {
      const blob = await presentationsApi.fetchScriptBlob(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: unknown) {
      toast.error(`Could not open script: ${getErrorMessage(err)}`);
    }
  };

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-navy-700 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">{label}</h2>
          <p className="text-slate-500 text-xs">{blurb}</p>
        </div>
        {active ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-green-300">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            Active: {active.title}{active.has_script ? ' · script ✓' : ' · no script'}
          </span>
        ) : (
          <span className="text-xs text-slate-500">No active deck</span>
        )}
      </div>

      {/* Upload row */}
      <div className="px-5 py-4 border-b border-navy-700 grid md:grid-cols-4 gap-3 items-end bg-navy-900/40">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Title</label>
          <input
            type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={`${label} deck`}
            className="w-full bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            .pptx <span className="text-red-400">*</span>
            <span className="text-slate-600 font-normal"> (select one or more — merged in order)</span>
          </label>
          <input
            ref={fileRef} type="file" accept=".pptx" multiple
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              if (list.length) setPptFiles((prev) => [...prev, ...list]);
              // Reset the input so re-selecting the same file fires onChange.
              e.target.value = '';
            }}
            className="w-full text-slate-300 text-xs file:mr-2 file:py-1.5 file:px-2 file:rounded file:border-0 file:bg-navy-700 file:text-slate-200 hover:file:bg-navy-600"
          />
          {pptFiles.length > 0 && (
            <div className="mt-2 space-y-1">
              {pptFiles.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center justify-between bg-navy-900 border border-navy-700 rounded px-2 py-1 text-xs">
                  <span className="text-slate-300 truncate">
                    <span className="text-slate-500 mr-1.5">{i + 1}.</span>
                    {f.name}
                    <span className="text-slate-600 ml-1.5">({(f.size / 1024 / 1024).toFixed(1)} MB)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removePpt(i)}
                    className="text-red-400 hover:text-red-300 text-xs ml-2 flex-shrink-0"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
              {pptFiles.length > 1 && (
                <div className="text-[10px] text-slate-500 mt-1">
                  Total: {(totalPptBytes / 1024 / 1024).toFixed(1)} MB · will be merged into one deck
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Script .pdf <span className="text-slate-600">(optional)</span></label>
          <input
            ref={scriptRef} type="file" accept=".pdf"
            onChange={(e) => setScriptFile(e.target.files?.[0] ?? null)}
            className="w-full text-slate-300 text-xs file:mr-2 file:py-1.5 file:px-2 file:rounded file:border-0 file:bg-navy-700 file:text-slate-200 hover:file:bg-navy-600"
          />
        </div>
        <button
          onClick={handleUpload} disabled={uploading}
          className="bg-gold-500 hover:bg-gold-400 disabled:bg-navy-700 disabled:text-slate-500 text-navy-900 font-semibold px-4 py-2 rounded-lg transition-colors text-sm"
        >
          {uploading ? 'Uploading…' : 'Upload + activate'}
        </button>
      </div>

      {/* Versions */}
      {presentations.length === 0 ? (
        <div className="px-5 py-4 text-slate-500 text-sm">No versions uploaded for this appointment type yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-5 py-2">Ver</th>
              <th className="text-left px-5 py-2">Title</th>
              <th className="text-left px-5 py-2">Slides</th>
              <th className="text-left px-5 py-2">Script</th>
              <th className="text-left px-5 py-2">Status</th>
              <th className="text-right px-5 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {presentations.map((p) => (
              <tr key={p.id} className="border-t border-navy-700 hover:bg-navy-900/40">
                <td className="px-5 py-2.5 text-slate-300">v{p.version}</td>
                <td className="px-5 py-2.5 text-white">{p.title}<div className="text-slate-600 text-xs">{formatDate(p.created_at)}</div></td>
                <td className="px-5 py-2.5 text-slate-400">{p.slide_count}</td>
                <td className="px-5 py-2.5">
                  {p.has_script ? (
                    <button onClick={() => handleViewScript(p.id)} className="text-gold-400 hover:text-gold-300 text-xs" title={p.script_filename || 'View script'}>
                      📄 {p.script_filename || 'script.pdf'}
                    </button>
                  ) : (
                    <span className="text-slate-600 text-xs">— none —</span>
                  )}
                </td>
                <td className="px-5 py-2.5">
                  {p.is_active
                    ? <span className="inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-green-900 text-green-300">Active</span>
                    : <span className="inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-navy-700 text-slate-400">Archived</span>}
                </td>
                <td className="px-5 py-2.5 text-right space-x-2 whitespace-nowrap">
                  <label className={`text-gold-400 hover:text-gold-300 text-xs cursor-pointer ${busyRow === p.id ? 'opacity-50 pointer-events-none' : ''}`}>
                    {p.has_script ? 'Replace script' : 'Attach script'}
                    <input type="file" accept=".pdf" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAttachScript(p.id, f); e.target.value = ''; }} />
                  </label>
                  {p.has_script && (
                    <button onClick={() => handleRemoveScript(p.id)} disabled={busyRow === p.id}
                      className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50">Remove script</button>
                  )}
                  {!p.is_active && (
                    <button onClick={() => handleActivate(p.id)} className="text-gold-400 hover:text-gold-300 text-xs">Activate</button>
                  )}
                  {!p.is_active && (
                    <button onClick={() => handleDelete(p.id)} className="text-red-400 hover:text-red-300 text-xs">Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
