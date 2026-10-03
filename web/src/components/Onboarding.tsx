import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, Check, FolderOpen, HardDrive, Plug, Sparkles, Wand2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { keys, queryClient, useProviders, useWorkspaces } from '../lib/queries';
import { errorText, useStore } from '../lib/store';
import type { MySettings, Workspace } from '../lib/types';
import { AutoRouterSettings } from './AutoRouterSettings';
import { PromptAssistSettings } from './PromptAssistSettings';
import { ProviderCard, SaveLocationTab } from './SettingsModal';
import { Button, Field, inputClass } from './ui';

const STEPS = [
  { id: 'welcome', title: 'Welcome to Spicy Studio', icon: Wand2 },
  { id: 'providers', title: 'Connect a provider', icon: Plug },
  { id: 'workspace', title: 'Your first workspace', icon: FolderOpen },
  { id: 'save', title: 'Where Save puts files', icon: HardDrive },
  { id: 'extras', title: 'Optional extras', icon: Zap },
  { id: 'done', title: "You're all set", icon: Check },
] as const;

/** Mark the wizard finished (or skipped); `false` shows it again (Settings → General). */
export async function setOnboarded(onboarded: boolean) {
  queryClient.setQueryData(['mySettings'], await api.patch<MySettings>('/api/me/settings', { onboarded }));
}

/**
 * First-run setup for a new account: connect a provider, name the first workspace, choose a save location,
 * and optionally pick Auto models and the prompt assistant. The step survives the Higgsfield login redirect.
 */
export function Onboarding({ userId }: { userId: string }) {
  const { set, toast } = useStore();
  const stepKey = `onboardingStep:${userId}`;
  const [step, setStep] = useState(() => { try { return Math.min(Number(localStorage.getItem(stepKey)) || 0, STEPS.length - 1); } catch { return 0; } });
  const { data: providers = [] } = useProviders();
  const connected = providers.some(p => p.configured);
  const current = STEPS[step];

  useEffect(() => { try { localStorage.setItem(stepKey, String(step)); } catch { /* private mode */ } }, [step]);
  // The wizard replaces Settings for now (e.g. after returning from the Higgsfield login).
  useEffect(() => { set({ modal: null }); }, []);

  async function finish() {
    try {
      await setOnboarded(true);
      try { localStorage.removeItem(stepKey); } catch { /* private mode */ }
    } catch (error) { toast(errorText(error), 'error'); }
  }

  const go = (to: number) => { setStep(to); document.getElementById('onboarding-body')?.scrollTo(0, 0); };

  return createPortal(
    <div className="pt-safe fade-in fixed inset-0 z-[55] flex flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <Wand2 className="size-5 text-accent" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">Set up Spicy Studio</div>
        {/* Progress: one dot per step. */}
        <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => <span key={s.id} className={clsx('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-accent' : i < step ? 'w-1.5 bg-accent/60' : 'w-1.5 bg-white/15')} />)}
        </div>
        {current.id !== 'done' && <button onClick={finish} className="-mr-2 ml-1 flex h-10 items-center rounded-lg px-2 text-xs text-muted hover:bg-white/6 hover:text-fg">Skip setup</button>}
      </header>

      <main id="onboarding-body" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-1 pb-8 pt-6 md:pt-10">
          <div className="flex items-center gap-3 px-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-accent"><current.icon className="size-5" /></span>
            <div>
              <div className="text-xs text-faint">Step {step + 1} of {STEPS.length}</div>
              <h1 className="text-xl font-semibold">{current.title}</h1>
            </div>
          </div>

          {current.id === 'welcome' && (
            <div className="space-y-3 px-4 pt-5 text-sm leading-relaxed text-muted">
              <p>Spicy Studio generates AI photos and videos with the providers you connect, keeps everything organised in
                workspaces and folders, and saves the results you like to your NAS or a server folder.</p>
              <ul className="space-y-2 text-fg">
                {[
                  'Connect at least one provider (SpicyAPI, Higgsfield or PoYo). You pay them directly.',
                  'Create a workspace for each person or project, with its own references and folders.',
                  'Choose where Save puts files, optionally without metadata.',
                ].map(t => <li key={t} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-accent" />{t}</li>)}
              </ul>
              <p>It takes a couple of minutes. Everything here can be changed later in Settings.</p>
            </div>
          )}

          {current.id === 'providers' && (
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted">Each provider has its own models and prices. Don't have an account yet? Use the links on a card to sign up, get a key and add credits, then paste the key here. One is enough to start; connecting several lets Auto models pick the cheapest.</p>
              {providers.map(p => <ProviderCard key={p.id} p={p} />)}
            </div>
          )}

          {current.id === 'workspace' && <WorkspaceStep onSaved={() => go(step + 1)} />}

          {current.id === 'save' && (
            <div className="pt-2">
              <p className="px-4 pt-2 text-sm text-muted">Results always stay in the studio; <span className="text-fg">Save</span> also copies one to your NAS (SMB share) or a folder on the server, into the workspace's folder. You can skip this and set it up later.</p>
              <SaveLocationTab />
            </div>
          )}

          {current.id === 'extras' && (
            <div className="space-y-6 p-4">
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 font-semibold"><Zap className="size-4 text-accent" />Auto models</h2>
                <AutoRouterSettings />
              </section>
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-accent" />Prompt assistant</h2>
                <div className="-m-4"><PromptAssistSettings /></div>
              </section>
            </div>
          )}

          {current.id === 'done' && (
            <div className="space-y-3 px-4 pt-5 text-sm leading-relaxed text-muted">
              <p>Write what you want in the create box at the bottom and press <span className="text-fg">Generate</span>. A few tips:</p>
              <ul className="space-y-2 text-fg">
                {[
                  'Add reference photos with + or by dropping them in; mention them as @image1, @image2…',
                  'Group photos of a person or outfit as an element (References → Elements) and mention it as @Name.',
                  'Open a result for Recreate, Animate, Save, Trim and more.',
                  'Everything from this setup is in Settings (the gear icon), where you can also run it again.',
                ].map(t => <li key={t} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-accent" />{t}</li>)}
              </ul>
            </div>
          )}
        </div>
      </main>

      <footer className="pb-safe shrink-0 border-t border-line">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          {step > 0 && current.id !== 'done' && <Button variant="ghost" onClick={() => go(step - 1)}><ArrowLeft className="size-4" />Back</Button>}
          <div className="ml-auto flex items-center gap-2">
            {current.id === 'providers' && !connected && <Button variant="ghost" onClick={() => go(step + 1)}>Later</Button>}
            {(current.id === 'save' || current.id === 'extras') && <Button variant="ghost" onClick={() => go(step + 1)}>Skip</Button>}
            {current.id === 'workspace' ? (
              // A key per step: reusing one <button> would let a click that advances a step finish as this form's submit.
              <Button key={`next-${current.id}`} variant="primary" type="submit" form="onboarding-workspace">Continue<ArrowRight className="size-4" /></Button>
            ) : current.id === 'done' ? (
              <Button key={`next-${current.id}`} variant="primary" onClick={finish}>Start creating<ArrowRight className="size-4" /></Button>
            ) : (
              <Button key={`next-${current.id}`} variant="primary" type="button" disabled={current.id === 'providers' && !connected} onClick={() => go(step + 1)}>
                {current.id === 'welcome' ? "Let's go" : 'Continue'}<ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>,
    document.body,
  );
}

/** Rename the first workspace ("My workspace") after the person or project, and set its save folders. */
function WorkspaceStep({ onSaved }: { onSaved: () => void }) {
  const toast = useStore(s => s.toast);
  const workspaceId = useStore(s => s.workspaceId);
  const { data: workspaces = [] } = useWorkspaces();
  const ws = workspaces.find(w => w.id === workspaceId) || workspaces[0];
  const [name, setName] = useState(ws?.name === 'My workspace' ? '' : ws?.name || '');
  const [rules, setRules] = useState(ws?.prefs.assistRules || '');
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ws) return onSaved();
    try {
      const trimmed = name.trim();
      // Save folders follow the name, unless they were already changed from the defaults.
      const defaults = ws.imageExportDir === `${slug(ws.name)}/images` && ws.videoExportDir === `${slug(ws.name)}/videos`;
      await api.patch<Workspace>(`/api/workspaces/${ws.id}`, {
        ...(trimmed ? { name: trimmed } : {}),
        ...(trimmed && defaults ? { imageExportDir: `${slug(trimmed)}/images`, videoExportDir: `${slug(trimmed)}/videos` } : {}),
        prefs: { assistRules: rules },
      });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      onSaved();
    } catch (error) { toast(errorText(error), 'error'); }
  }

  return (
    <form id="onboarding-workspace" onSubmit={save} className="space-y-4 p-4">
      <p className="text-sm text-muted">A workspace keeps one person's (or project's) generations, references, elements and folders together. Make one per influencer; you can add more from the workspace menu at the top.</p>
      <Field label="Name" hint="e.g. the influencer's name. Saved files go into a folder with this name.">
        <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder={ws?.name || 'My workspace'} autoFocus />
      </Field>
      <Field label="Prompt assistant preferences (optional)" hint="Her look, style, usual places: added whenever the prompt assistant rewrites prompts in this workspace.">
        <textarea className={`${inputClass} h-auto min-h-20 py-2.5 leading-relaxed`} rows={3} maxLength={4000} value={rules} onChange={e => setRules(e.target.value)}
          placeholder="e.g. Freckles, no makeup, natural light. Her apartment has a beige sofa." />
      </Field>
    </form>
  );
}
