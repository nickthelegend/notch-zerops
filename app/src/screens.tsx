/**
 * The Zerops screens, in Notch's design system.
 *
 * Two screens and no third: paste a token, or work on a project. There is deliberately no calm
 * "empty" state — an account with no services and an unreachable API must never render the same
 * way, so a failed call paints an error panel rather than a blank canvas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, Text, TextInput, View } from 'react-native';

import { T, radii, spacing } from './theme';
import { Badge, Btn, Callout, Empty, MetricCard, Panel, SectionLabel, Segmented, ago, field } from './components';
import { ArchCanvas, type Board, type Ghost } from './arch';
import { ChatPanel } from './chat';
import { Toasts, useToasts } from './toast';
import { ActionsPanel, ArchitectPanel, AutopilotPanel } from './swarm';
import { canPickFolder, canSaveFile, pickFolder, saveYaml } from './native';
import { api, onReachChange, type Action, type BrainEvent, type Comparison, type Cycle, type Design, type DriftResp, type Graph, type Hygiene, type Plan, type Project, type Reach, type Session } from './api';

/* ------------------------------------------------------------------ gate */

export function TokenScreen({ onConnected }: { onConnected: (s: Session) => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  /* This screen keeps its inline banner: there is nothing else on it to be pushed down. */
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (token.trim() === '' || busy) return;
    setBusy(true); setError(null);
    try { onConnected(await api.connect(token.trim())); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: spacing.lg, paddingTop: 64, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 460 }}>
        <Text style={{ color: T.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 }}>Notch</Text>
        <Text style={{ color: T.dim, fontSize: 14, marginTop: 8, lineHeight: 20 }}>
          Your Zerops architecture, drawn from your account — with the gaps marked.
        </Text>

        <Text style={{ color: T.dim, fontFamily: T.mono, fontSize: 11, letterSpacing: 1, marginTop: 28, marginBottom: 8 }}>
          ZEROPS PERSONAL ACCESS TOKEN
        </Text>
        <TextInput
          style={[field, { fontFamily: T.mono, fontSize: 13 }]}
          value={token}
          onChangeText={setToken}
          placeholder="paste it here"
          placeholderTextColor={T.faint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void connect()}
        />
        <View style={{ marginTop: 14 }}>
          <Btn label={busy ? 'checking with Zerops…' : 'Connect'} primary onPress={() => void connect()} />
        </View>

        {error !== null && (
          <View style={{ marginTop: 14 }}>
            <Callout label="REJECTED" text={error} tint={T.err} />
          </View>
        )}

        <Text style={{ color: T.faint, fontSize: 12, marginTop: 20, lineHeight: 18 }}>
          Verified by a real API call, not by checking it looks like a token. It is held in the
          daemon's memory for this session only — never written to disk, never logged, never sent
          anywhere but Zerops.
        </Text>
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ main */

type Tab = 'arch' | 'drift' | 'secrets' | 'design' | 'auto' | 'actions' | 'envs' | 'time';

export function ProjectScreen({ session, onDisconnect }: { session: Session; onDisconnect: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [graph, setGraph] = useState<Graph | null>(null);
  const [drift, setDrift] = useState<DriftResp | null>(null);
  const [dir, setDir] = useState('');
  const [tab, setTab] = useState<Tab>('arch');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<(Plan & { types: string[]; ha: boolean }) | null>(null);
  const [ha, setHa] = useState(false);
  /** Services placed on the board by hand, folded into the same provision plan. */
  const [added, setAdded] = useState<string[]>([]);
  const [hygiene, setHygiene] = useState<Hygiene | null>(null);

  /* The evidential log: every REST call this session, polled incrementally. */
  const [actions, setActions] = useState<Action[]>([]);
  const [actionCounts, setActionCounts] = useState({ total: 0, writes: 0, failed: 0, ms: 0 });

  /* The panel that argues about scaling. Disarmed until somebody says otherwise. */
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [watching, setWatching] = useState('');
  const [armed, setArmed] = useState(false);
  const [ceiling, setCeiling] = useState(3);

  /* Plain English in, a service set with an argument out. */
  const [design, setDesign] = useState<Design | null>(null);
  const [brief, setBrief] = useState('');
  const [designAgent, setDesignAgent] = useState('');
  const [agentList, setAgentList] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    void api.agents()
      .then((r) => { setAgentList(r.agents); setDesignAgent((c) => (c === '' ? r.agents[0]?.id ?? '' : c)); })
      .catch(() => setAgentList([]));
  }, []);
  /**
   * Whether the daemon is answering. Not `navigator.onLine` — the daemon is on loopback, so
   * the machine can be off the network with everything working, and on it with the daemon dead.
   */
  const [reach, setReach] = useState<Reach>('ok');
  useEffect(() => onReachChange(setReach), []);
  /*
   * Transient messages go OVER the app, not into the column.
   *
   * These were `Callout` banners in the main flow, and each one shortened the canvas: three
   * actions in a row and the board you were working on was off the bottom of the window, under
   * a stack of notices about things you had already done. Nothing is lost by fading — every one
   * of these is also an entry in the action log, which is the durable place to look.
   */
  const { toasts, push, dismiss } = useToasts();
  const setError = (t: string | null): void => { if (t !== null && t !== '') push('error', 'error', t); };
  const setNotice = (n: { label: string; text: string } | null): void => {
    if (n !== null) push('ok', n.label, n.text);
  };
  const setCreated = (t: string | null): void => { if (t !== null && t !== '') push('ok', 'provisioned', t); };
  const [events, setEvents] = useState<BrainEvent[] | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [against, setAgainst] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [deployed, setDeployed] = useState<{
    url: string | null; note: string; done: boolean; ok: boolean | null;
    health: { status: number; ms: number } | null; lines: string[];
  } | null>(null);

  /** In-flight guard in a ref: `setBusy(true)` has not landed when a second tap arrives. */
  const inFlight = useRef(false);
  const guard = async (fn: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await fn(); } finally { inFlight.current = false; setBusy(false); }
  };

  useEffect(() => {
    void api.projects()
      .then((r) => { setProjects(r.projects); setProjectId((cur) => (cur === '' ? r.projects[0]?.id ?? '' : cur)); })
      .catch((e: Error) => setError(e.message));
  }, []);

  /** Findings belong to the project they came from. A switch makes them wrong, not stale. */
  useEffect(() => {
    setDrift(null); setPlan(null); setCreated(null); setEvents(null); setError(null); setNotice(null);
    setComparison(null); setAgainst(''); setDeployed(null); setAdded([]);
  }, [projectId]);

  /**
   * Push the repository to its runtime.
   *
   * The step that turns "your project has six empty services" into "your app is running at
   * this address". It runs the build the repository committed — Notch chooses what and where,
   * `zerops.yml` decides how.
   */
  const deploy = () => void guard(async () => {
    if (dir.trim() === '' || projectId === '') return;
    setError(null);
    setDeployed({ url: null, note: 'Starting…', done: false, ok: null, health: null, lines: [] });
    try {
      const { runId } = await api.deploy(projectId, dir.trim(), 'nodejs');
      /*
       * Poll, and show the build as it happens.
       *
       * A Zerops build runs for minutes. Awaiting one request for that long leaves the app
       * frozen on a spinner through the most convincing part of the whole thing — real work,
       * on somebody else's computer, with the log to prove it.
       */
      let from = 0;
      for (;;) {
        const s = await api.deployStatus(runId, from);
        from = s.total;
        setDeployed((cur) => ({
          url: s.url,
          note: s.note !== '' ? s.note : cur?.note ?? '',
          done: s.done,
          ok: s.ok,
          health: s.health,
          // Bounded: a build log runs to hundreds of lines and only the tail is readable.
          lines: [...(cur?.lines ?? []), ...s.lines].slice(-120),
        }));
        if (s.done) break;
        await new Promise((r) => setTimeout(r, 900));
      }
      setEvents((await api.history(projectId)).events);
    } catch (e) {
      setError((e as Error).message);
      setDeployed((cur) => (cur === null ? null : { ...cur, done: true, ok: false }));
    }
  });

  /** Compare this project against another one on the account. */
  const compare = (otherId: string) => void guard(async () => {
    setAgainst(otherId);
    setError(null);
    try { setComparison(await api.compare(projectId, otherId)); }
    catch (e) { setError((e as Error).message); setComparison(null); }
  });

  const loadGraph = useCallback(async (pid: string) => {
    if (pid === '') return;
    setError(null);
    try { setGraph(await api.graph(pid)); }
    catch (e) { setError((e as Error).message); setGraph(null); }
  }, []);

  useEffect(() => { void loadGraph(projectId); }, [projectId, loadGraph]);

  const scan = () => void guard(async () => {
    if (dir.trim() === '' || projectId === '') return;
    setError(null); setCreated(null); setPlan(null); setNotice(null);
    try {
      const d = await api.drift(projectId, dir.trim());
      setDrift(d); setGraph(d.graph);
      /*
       * Sweep for committed credentials in the same gesture.
       *
       * Not a separate button: nobody clicks "check my secrets" — they find out from someone
       * else. It rides along with the scan they were going to run anyway, and it never blocks
       * the scan result, because a hygiene failure must not cost you your drift report.
       */
      api.hygiene(dir.trim()).then(setHygiene).catch(() => setHygiene(null));
      setEvents((await api.history(projectId)).events);
    } catch (e) { setError((e as Error).message); }
  });

  /*
   * What the plan will create: what the scan found missing, PLUS whatever was dropped on the
   * board by hand. One list, one preview, one confirm — a service you added yourself goes
   * through exactly the same import file as a service the scanner asked for, because two
   * paths to provisioning is two things to get wrong.
   */
  const missing = useMemo(
    () => [...new Set([...(drift?.drift.provisionable ?? []).map((i) => i.type), ...added])],
    [drift, added]);

  const preview = () => void guard(async () => {
    setError(null); setCreated(null);
    try {
      const p = await api.plan(projectId, missing, ha, dir.trim());
      // The plan carries the inputs it was built from, so the confirm cannot use different
      // ones. The HA switch stays live while this is on screen.
      setPlan({ ...p, types: missing, ha });
    } catch (e) { setError((e as Error).message); }
  });

  const provision = () => void guard(async () => {
    if (plan === null) return;
    setError(null);
    try {
      const r = await api.provision(projectId, plan.types, plan.ha, dir.trim());
      setCreated(`Created ${r.created.map((c) => c.hostname).join(', ')}. ${r.note}`);
      setPlan(null);
      if (r.graph !== null) setGraph(r.graph);
      if (dir.trim() !== '') {
        const d = await api.drift(projectId, dir.trim());
        setDrift(d); setGraph(d.graph);
      }
      setEvents((await api.history(projectId)).events);
    } catch (e) { setError((e as Error).message); }
  });

  const create = () => void guard(async () => {
    const name = (newName ?? '').trim();
    if (name === '') return;
    setError(null);
    try {
      const r = await api.createProject(name);
      setProjects((cur) => [r.project, ...(cur ?? [])]);
      setProjectId(r.project.id);
      setNewName(null);
      setNotice({ label: 'CREATED', text: `Created project “${r.project.name}”. It is empty — scan a repo to see what it needs.` });
    } catch (e) { setError((e as Error).message); }
  });

  const ghosts: Ghost[] = useMemo(() => {
    const found = (drift?.drift.items ?? [])
      .filter((i) => i.status === 'missing')
      .map((i) => ({ type: i.type, reason: i.summary, confidence: i.required?.confidence ?? 'strong' }));
    const seen = new Set(found.map((g) => g.type));
    return [
      ...found,
      ...added.filter((t) => !seen.has(t)).map((t) => ({
        type: t, reason: 'You added this on the board.', confidence: 'strong',
      })),
    ];
  }, [drift, added]);

  /** Pull in whatever the daemon has logged since we last looked. */
  const loadActions = useCallback(async () => {
    try {
      const r = await api.actions(0);
      setActions(r.actions);
      setActionCounts(r.counts);
    } catch { /* the reach banner already says the daemon is down */ }
  }, []);

  /*
   * One observe → argue → decide → (apply) cycle.
   *
   * Slow on purpose: it puts real requests through the service and then waits on three agent
   * CLIs. The button says "watching…" for as long as that takes rather than pretending to be
   * instant.
   */
  const runCycle = () => void guard(async () => {
    if (projectId === '' || watching === '') return;
    setCycle(null);
    try {
      const c = await api.swarmCycle({
        projectId, serviceId: watching, armed, floor: 1, ceiling,
        requests: 24, concurrency: 6,
      });
      setCycle(c);
      if (c.applied !== null) {
        setNotice({
          label: 'SCALED',
          text: `${c.decision.votes} of ${c.decision.of} agents agreed. ${c.applied.note}`,
        });
      }
      void loadActions();
      setEvents((await api.history(projectId)).events);
    } catch (e) { setError((e as Error).message); }
  });

  const runDesign = () => void guard(async () => {
    if (designAgent === '' || brief.trim() === '') return;
    setDesign(null);
    try {
      const d = await api.architect(designAgent, brief.trim());
      setDesign(d);
      void loadActions();
    } catch (e) { setError((e as Error).message); }
  });

  /** Drop a service on the board. It joins the plan; nothing is created until you confirm. */
  const addService = (type: string) => {
    setAdded((cur) => (cur.includes(type) ? cur : [...cur, type]));
    setPlan(null);
    setNotice({ label: 'ADDED', text: `${type} is on the board. Preview the plan to see the import file it produces.` });
  };

  /*
   * Keep the action log current while it is on screen.
   *
   * Polled rather than pushed: the daemon already answers a cheap incremental read, and a
   * websocket for a list that changes a few times a minute is machinery nobody needs. It only
   * runs while the tab is open, so a session spent on the board costs nothing.
   */
  useEffect(() => {
    if (tab !== 'actions') return;
    void loadActions();
    const h = setInterval(() => void loadActions(), 2000);
    return () => clearInterval(h);
  }, [tab, loadActions]);

  /* Watch the runtime by default — it is the only thing in a project that serves traffic. */
  useEffect(() => {
    if (graph === null) return;
    setWatching((cur) => {
      if (cur !== '' && graph.nodes.some((n) => n.id === cur)) return cur;
      return graph.nodes.find((n) => n.kind === 'runtime')?.id ?? graph.nodes[0]?.id ?? '';
    });
  }, [graph]);

  const counts = drift?.drift.counts;
  const current = projects?.find((p) => p.id === projectId);

  const board: Board | null = graph === null ? null : {
    graph,
    ghosts,
    repo: drift === null ? null : {
      dir: drift.dir,
      scanned: drift.scanned,
      satisfied: counts?.['satisfied'] ?? 0,
      missing: counts?.['missing'] ?? 0,
    },
    wiring: drift?.wiring ?? null,
    added,
  };

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      {/* ---- bar ---- */}
      <View style={{ borderBottomColor: T.line, borderBottomWidth: 1, backgroundColor: T.panel, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Text style={{ color: T.text, fontWeight: '800', fontSize: 16 }}>Notch</Text>
          <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 11 }}>
            {session.email} · {session.tokenHint}
          </Text>
          <View style={{ flex: 1 }} />
          <Btn small label={chatOpen ? 'Hide agents' : 'Ask an agent'} onPress={() => setChatOpen(!chatOpen)} />
          <Btn small label={newName === null ? 'New project' : 'Cancel'} onPress={() => setNewName(newName === null ? '' : null)} />
          <Btn small label="Disconnect" onPress={() => { void api.disconnect().catch(() => {}); onDisconnect(); }} />
        </View>

        {/* project chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }}>
          {projects === null ? (
            <Text style={{ color: T.faint, fontSize: 12 }}>loading projects…</Text>
          ) : projects.length === 0 ? (
            <Text style={{ color: T.warn, fontSize: 12 }}>
              No projects on this account. Create one with “New project”.
            </Text>
          ) : projects.map((p) => {
            const on = p.id === projectId;
            return (
              <View key={p.id} style={{ borderRadius: radii.pill, overflow: 'hidden' }}>
                <Text
                  onPress={() => setProjectId(p.id)}
                  style={{
                    color: on ? T.onBright : T.dim,
                    backgroundColor: on ? T.bright : T.raised,
                    borderColor: on ? T.bright : T.line,
                    borderWidth: 1,
                    borderRadius: radii.pill,
                    paddingHorizontal: 12, paddingVertical: 6,
                    fontSize: 12, fontWeight: on ? '700' : '500',
                    overflow: 'hidden',
                  }}
                >
                  {p.name} · {p.status}
                </Text>
              </View>
            );
          })}
        </ScrollView>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <TextInput
            style={[field, { flex: 1, minWidth: 200, fontFamily: T.mono, fontSize: 12, paddingVertical: 8 }]}
            value={dir}
            onChangeText={setDir}
            placeholder="/path/to/your/repo"
            placeholderTextColor={T.faint}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={scan}
          />
          {/* Only inside the desktop shell — a browser has no directory chooser to offer. */}
          {canPickFolder() && (
            <Btn small label="Choose…" onPress={() => { void pickFolder().then((p) => { if (p !== null) setDir(p); }); }} />
          )}
          <Btn small primary label={busy ? '…' : 'Scan repo'} onPress={scan} />
          {dir.trim() !== '' && projectId !== '' && (
            <Btn small label={busy ? 'deploying…' : 'Deploy'} onPress={deploy} />
          )}
          <Btn small label="Refresh" onPress={() => void loadGraph(projectId)} />
          {dir.trim() !== '' && projectId !== '' && (
            <Btn
              small
              label="Export yaml"
              onPress={() => {
                const url = api.exportUrl(projectId, dir.trim(), ha);
                // In the shell: a real save dialog, and we can say where it went. In a
                // browser: the browser's own download, which is all it can offer.
                if (canSaveFile()) {
                  // A rejected save used to disappear into an unhandled rejection, so the
                  // button just did nothing. Say what went wrong instead.
                  void saveYaml(url)
                    .then((p) => { if (p !== null) setNotice({ label: 'EXPORTED', text: `Wrote ${p}` }); })
                    .catch((e: Error) => setError(`Could not write zerops.yaml: ${e.message}`));
                } else {
                  void Linking.openURL(url);
                }
              }}
            />
          )}
          {projectId !== '' && (
            <Btn
              small
              label="Copy diagram"
              onPress={() => void guard(async () => {
                setError(null);
                try {
                  const text = await api.mermaid(projectId, dir.trim());
                  /*
                   * Straight to the clipboard, not to a file. The next thing anybody does with
                   * a Mermaid block is paste it into a README or a PR description, and a
                   * download would put a step in the way of the only use it has.
                   */
                  await navigator.clipboard.writeText(text);
                  setNotice({
                    label: 'COPIED',
                    text: `A Mermaid diagram of this project is on your clipboard — ${text.split('\n').length} lines. Paste it into a README and GitHub renders it.`,
                  });
                } catch (e) { setError(`Could not build the diagram: ${(e as Error).message}`); }
              })}
            />
          )}
        </View>
      </View>

      {/* ---- create form ---- */}
      {newName !== null && (
        <View style={{ padding: spacing.md, borderBottomColor: T.line, borderBottomWidth: 1 }}>
          <Panel tint={T.warn}>
            <SectionLabel text="CREATE AN EMPTY PROJECT" />
            <View style={{ flexDirection: 'row', gap: 8, padding: spacing.md, paddingTop: 0, alignItems: 'center' }}>
              <TextInput
                style={[field, { flex: 1, paddingVertical: 8 }]}
                value={newName}
                onChangeText={setNewName}
                placeholder="project name"
                placeholderTextColor={T.faint}
                autoCapitalize="none"
                onSubmitEditing={create}
              />
              <Btn small primary label={busy ? 'creating…' : 'Create'} onPress={create} />
            </View>
            <Text style={{ color: T.dim, fontSize: 12, paddingHorizontal: spacing.md, paddingBottom: spacing.md, lineHeight: 17 }}>
              This creates a real project. It starts empty — nothing is provisioned into it until
              you scan a repo and confirm the import file.
            </Text>
          </Panel>
        </View>
      )}

      {/* ---- banners ---- */}
      {/*
        The daemon stopped answering.

        Above everything, and it stays until a call succeeds — a dead daemon makes every other
        thing on this screen a lie, including the parts that still look fine because they were
        fetched a minute ago.
      */}
      {reach === 'unreachable' && (
        <View style={{ padding: spacing.md, paddingBottom: 0 }}>
          <Callout
            label="NOT ANSWERING"
            tint={T.err}
            text={'The Brain daemon stopped responding. Everything on screen is from the last successful call and may already be wrong. Notch retries reads automatically; this clears itself when one gets through.'}
          />
        </View>
      )}
      {deployed !== null && (
        <View style={{ padding: spacing.md }}>
          <Panel tint={!deployed.done ? T.thread : deployed.ok === true ? T.ok : T.err}>
            <SectionLabel text={
              !deployed.done ? 'BUILDING ON ZEROPS'
                : deployed.ok === true
                  ? (deployed.health !== null ? `LIVE — HTTP ${deployed.health.status} IN ${deployed.health.ms}MS` : 'DEPLOYED')
                  : 'DEPLOY FAILED'
            } />
            <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 8 }}>
              {deployed.url !== null && (
                <Text
                  onPress={() => void Linking.openURL(deployed.url as string)}
                  style={{ color: T.thread, fontFamily: T.mono, fontSize: 13.5 }}
                >
                  {deployed.url}
                </Text>
              )}
              {deployed.note !== '' && (
                <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>{deployed.note}</Text>
              )}
              {deployed.lines.length > 0 && (
                <ScrollView
                  style={{ maxHeight: 190, backgroundColor: T.editor, borderColor: T.line, borderWidth: 1, borderRadius: radii.input }}
                  contentContainerStyle={{ padding: 10 }}
                  ref={(r) => { if (!deployed.done) r?.scrollToEnd({ animated: false }); }}
                >
                  {deployed.lines.map((l, i) => (
                    <Text key={`${i}-${l.slice(0, 24)}`} style={{ color: T.faint, fontFamily: T.mono, fontSize: 10.5, lineHeight: 15 }}>
                      {l}
                    </Text>
                  ))}
                </ScrollView>
              )}
            </View>
          </Panel>
        </View>
      )}

      {/* ---- plan ---- */}
      {plan !== null && (
        <ScrollView style={{ maxHeight: 340, borderBottomColor: T.line, borderBottomWidth: 1 }} contentContainerStyle={{ padding: spacing.md }}>
          <Panel tint={T.warn}>
            <SectionLabel text={`THIS WILL CREATE ${plan.services.length} REAL SERVICE(S)`} />
            <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
              <View style={{ backgroundColor: T.editor, borderColor: T.line, borderWidth: 1, borderRadius: radii.input, padding: 10 }}>
                <Text style={{ color: T.text, fontFamily: T.mono, fontSize: 11, lineHeight: 16 }}>
                  {plan.yaml || '(nothing resolvable)'}
                </Text>
              </View>

              {plan.wiringSnippet !== '' && (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ color: T.warn, fontSize: 12, lineHeight: 17, marginBottom: 6 }}>
                    Creating these does not tell your app where they are. Add this to your
                    repository's <Text style={{ fontFamily: T.mono }}>zerops.yml</Text> — the import
                    file cannot do it, the build file can:
                  </Text>
                  <View style={{ backgroundColor: T.editor, borderColor: T.line, borderWidth: 1, borderRadius: radii.input, padding: 10 }}>
                    <Text selectable style={{ color: T.thread, fontFamily: T.mono, fontSize: 11, lineHeight: 16 }}>
                      {plan.wiringSnippet}
                    </Text>
                  </View>
                </View>
              )}

              {plan.secrets.length > 0 && (
                <Text style={{ color: T.warn, fontSize: 12, marginTop: 10, lineHeight: 17 }}>
                  {plan.secrets.length} secret(s) found by name — {plan.secrets.join(', ')}. Zerops
                  generates the values during the import, so nothing is copied out of your repo and
                  no secret appears in this file.
                </Text>
              )}
              {plan.unresolved.length > 0 && (
                <Text style={{ color: T.dim, fontSize: 12, marginTop: 8, lineHeight: 17 }}>
                  No Zerops service type matches: {plan.unresolved.join(', ')}. Skipped rather than
                  guessed at.
                </Text>
              )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <Btn primary label={busy ? 'creating…' : 'Confirm and create'} onPress={provision} />
                <Btn label="Cancel" onPress={() => setPlan(null)} />
              </View>
            </View>
          </Panel>
        </ScrollView>
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />

      {/* The board and the agents, side by side: you ask about what you are looking at. */}
      <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
      <View style={{ flex: 1, minWidth: 0 }}>

      {/* ---- tabs ---- */}
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        accent={T.primary}
        options={[
          { key: 'arch', label: 'Architecture' },
          { key: 'drift', label: counts === undefined ? 'Drift' : `Drift (${(counts['missing'] ?? 0) + (drift?.config?.missing.length ?? 0)})` },
          { key: 'secrets', label: hygiene === null ? 'Secrets' : `Secrets (${hygiene.findings.length})`, alert: (hygiene?.findings.length ?? 0) > 0 },
          { key: 'design', label: 'Design' },
          { key: 'auto', label: armed ? 'Autopilot · armed' : 'Autopilot', alert: armed },
          { key: 'actions', label: actionCounts.total === 0 ? 'Actions' : `Actions (${actionCounts.total})` },
          { key: 'envs', label: comparison === null ? 'Environments' : `Environments (${comparison.differences.length})` },
          { key: 'time', label: events === null ? 'Timeline' : `Timeline (${events.length})` },
        ]}
      />

      {tab === 'arch' && (
        board === null
          ? <Empty text="Loading your architecture…" />
          : <ArchCanvas board={board} onAdd={addService} onProvision={preview} busy={busy} />
      )}

      {tab === 'drift' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
          {counts === undefined ? (
            <Empty text="Type a repo path and hit Scan repo. Nothing is read until you do." />
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <MetricCard label="SATISFIED" value={String(counts['satisfied'] ?? 0)} />
                <MetricCard label="MISSING" value={String(counts['missing'] ?? 0)} accent />
                <MetricCard label="UNREFERENCED" value={String(counts['unreferenced'] ?? 0)} />
              </View>

              <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 11 }}>
                read {drift?.scanned.join(', ') || 'nothing'} in {drift?.dir}
              </Text>

              {drift?.note !== undefined && <Callout label="NOTE" text={drift.note} tint={T.warn} />}
              {drift?.historyNote !== undefined && <Callout label="NOT RECORDED" text={drift.historyNote} tint={T.warn} />}

              {/*
                Config drift, above the service list on purpose.
                A missing service fails loudly at deploy; a missing variable deploys clean and
                kills the app on the first request that reads it. The quieter failure gets the
                louder placement.
              */}
              {(drift?.config?.missing.length ?? 0) > 0 && (
                <Panel tint={T.err}>
                  <SectionLabel text="SET, BUT NOT HERE" />
                  <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 7 }}>
                    <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>
                      The repo reads {drift?.config?.missing.length} variable(s) this project does
                      not define. The deploy will succeed and the app will fail at runtime.
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                      {(drift?.config?.missing ?? []).map((k) => (
                        <Text key={k} style={{
                          color: T.err, fontFamily: T.mono, fontSize: 11,
                          backgroundColor: '#2a1a1e', borderColor: '#4a2b32', borderWidth: 1,
                          borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3, overflow: 'hidden',
                        }}>{k}</Text>
                      ))}
                    </View>
                    {(drift?.config?.provided.length ?? 0) > 0 && (
                      <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17 }}>
                        Not listed: {(drift?.config?.provided ?? []).map((p) => `${p.key} (${p.by} provides it)`).join(', ')}.
                      </Text>
                    )}
                  </View>
                </Panel>
              )}

              {missing.length > 0 && (
                <Panel>
                  <SectionLabel text="PROVISION WHAT IS MISSING" />
                  <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 8 }}>
                    <Text
                      onPress={() => setHa(!ha)}
                      style={{ color: ha ? T.ok : T.dim, fontSize: 12, fontFamily: T.mono }}
                    >
                      [{ha ? '×' : ' '}] HA where the platform has an HA version
                    </Text>
                    <Btn primary label={`Provision ${missing.length} missing…`} onPress={preview} />
                  </View>
                </Panel>
              )}

              {(drift?.drift.items ?? []).map((i) => {
                const tint = i.status === 'missing' ? T.err : i.status === 'satisfied' ? T.ok : T.dim;
                const streak = drift?.history?.find((h) => h.type === i.type);
                return (
                  <Panel key={i.status + i.type}>
                    <View style={{ padding: spacing.md, gap: 6 }}>
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Badge text={i.status} tint={tint} />
                        <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{i.type}</Text>
                        {i.required?.confidence === 'likely' && <Badge text="low confidence" tint={T.warn} />}
                      </View>
                      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>{i.summary}</Text>

                      {streak !== undefined && streak.scans > 1 && i.status === 'missing' && (
                        <Text style={{ color: T.warn, fontSize: 11.5 }}>
                          Missing across {streak.scans} scans — first seen {ago(streak.firstSeen)}.
                        </Text>
                      )}

                      {(i.required?.evidence ?? []).map((e) => (
                        <Text key={e.path + e.found} style={{ color: T.faint, fontFamily: T.mono, fontSize: 11 }}>
                          {e.found} in {e.path}
                        </Text>
                      ))}
                    </View>
                  </Panel>
                );
              })}

              {(drift?.drift.notes ?? []).map((n) => <Callout key={n} label="NOTE" text={n} tint={T.dim} />)}
            </>
          )}
        </ScrollView>
      )}

      {/*
        WHAT GIT IS ALREADY CARRYING.

        The one screen here that is about the repository alone — no Zerops call, no project.
        It earns its tab because it answers a question nobody thinks to ask until it is far too
        late, and because the answer is usually "you are fine", which is worth seeing stated.
      */}
      {tab === 'secrets' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
          {hygiene === null ? (
            <Empty text="Scan a repo and Notch sweeps it for credentials git is already tracking." />
          ) : hygiene.tracked === null ? (
            <Callout
              label="COULD NOT TELL"
              tint={T.warn}
              text={hygiene.notes.join(' ')}
            />
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <MetricCard label="TRACKED BY GIT" value={String(hygiene.tracked)} />
                <MetricCard label="READ" value={String(hygiene.scanned)} />
                <MetricCard
                  label="EXPOSED"
                  value={String(hygiene.findings.length)}
                  accent={hygiene.findings.length > 0}
                />
              </View>

              {hygiene.findings.length === 0 ? (
                <Callout
                  label="CLEAN"
                  tint={T.ok}
                  text={`Read ${hygiene.scanned} of the ${hygiene.tracked} files git is tracking and found no credentials in any of them. This checks committed files only — a .env that git ignores is exactly where it should be.`}
                />
              ) : (
                <>
                  <Callout
                    label={hygiene.findings.length === 1 ? '1 CREDENTIAL IS IN YOUR REPOSITORY' : `${hygiene.findings.length} CREDENTIALS ARE IN YOUR REPOSITORY`}
                    tint={T.err}
                    text="These are in files git tracks, so they are in your history. Deleting the line does not remove them — rotate each one at its issuer."
                  />
                  {hygiene.findings.map((f) => (
                    <Panel key={`${f.path}:${f.line}:${f.rule}`}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Badge
                          text={f.severity.toUpperCase()}
                          tint={f.severity === 'critical' ? T.err : f.severity === 'high' ? T.warn : T.dim}
                        />
                        <Text style={{ color: T.text, fontSize: 13.5, fontWeight: '700' }}>{f.rule}</Text>
                      </View>
                      <Text selectable style={{ color: T.thread, fontFamily: T.mono, fontSize: 11.5, marginTop: 7 }}>
                        {f.path}:{f.line}{f.key === null ? '' : `  ·  ${f.key}`}
                      </Text>
                      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18, marginTop: 6 }}>
                        {f.advice}
                      </Text>
                    </Panel>
                  ))}
                </>
              )}

              {hygiene.notes.map((n) => <Callout key={n} label="NOTE" text={n} tint={T.warn} />)}

              <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17 }}>
                Notch never reads a credential back to you. A finding is a file, a line and a
                kind — enough to fix it, and nothing that would put the secret in a screenshot.
              </Text>
            </>
          )}
        </ScrollView>
      )}

      {tab === 'design' && (
        <ArchitectPanel
          agents={agentList}
          agent={designAgent}
          onAgent={setDesignAgent}
          description={brief}
          onDescription={setBrief}
          design={design}
          onRun={runDesign}
          busy={busy}
          onAdopt={(types) => {
            setAdded((cur) => [...new Set([...cur, ...types])]);
            setPlan(null);
            setTab('arch');
            setNotice({
              label: 'ADDED',
              text: `${types.length} service(s) from ${design?.agent ?? 'the agent'} are on the board. Nothing is created until you confirm the plan.`,
            });
          }}
        />
      )}

      {tab === 'auto' && (
        <AutopilotPanel
          services={graph?.nodes.filter((n) => !n.system) ?? []}
          serviceId={watching}
          onService={setWatching}
          cycle={cycle}
          onRun={runCycle}
          busy={busy}
          armed={armed}
          onArmed={setArmed}
          ceiling={ceiling}
          onCeiling={setCeiling}
        />
      )}

      {tab === 'actions' && (
        <ActionsPanel actions={actions} counts={actionCounts} onRefresh={() => void loadActions()} busy={busy} />
      )}

      {tab === 'envs' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
          <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
            Zerops shows one project at a time, which is exactly the view in which dev, stage and
            production drift apart. Pick another project and hold them against each other.
          </Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {(projects ?? []).filter((p) => p.id !== projectId).map((p) => {
              const on = p.id === against;
              return (
                <Text
                  key={p.id}
                  onPress={() => compare(p.id)}
                  style={{
                    color: on ? T.onBright : T.dim,
                    backgroundColor: on ? T.bright : T.raised,
                    borderColor: on ? T.bright : T.line, borderWidth: 1,
                    borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 6,
                    fontSize: 12, fontWeight: on ? '700' : '500', overflow: 'hidden',
                  }}
                >
                  vs {p.name}
                </Text>
              );
            })}
          </ScrollView>

          {comparison === null ? (
            <Empty text={(projects ?? []).length < 2
              ? 'This account has only one project — there is nothing to compare it with yet.'
              : 'Pick a project above.'} />
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <MetricCard label="DIFFERENCES" value={String(comparison.differences.length)} accent={comparison.differences.length > 0} />
                <MetricCard label="IDENTICAL" value={String(comparison.identical.length)} />
              </View>

              {comparison.differences.length === 0 ? (
                <Callout label="MATCHED" tint={T.ok}
                  text={`${comparison.a} and ${comparison.b} agree on every service, version, mode, route and variable name compared.`} />
              ) : comparison.differences.map((d, i) => {
                const tint = d.severity === 'high' ? T.err : d.severity === 'medium' ? T.warn : T.dim;
                return (
                  <Panel key={`${d.kind}-${d.subject}-${i}`}>
                    <View style={{ padding: spacing.md, gap: 6 }}>
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Badge text={d.severity} tint={tint} />
                        <Text style={{ color: T.text, fontWeight: '700', fontSize: 13.5 }}>{d.subject}</Text>
                        <Badge text={d.kind.replace(/_/g, ' ')} />
                      </View>

                      {/* The two sides, side by side. This is the whole feature. */}
                      <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
                        <View style={{ flex: 1, backgroundColor: T.raised, borderColor: T.line, borderWidth: 1, borderRadius: radii.input, padding: 9 }}>
                          <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 9.5 }}>{comparison.a.toUpperCase()}</Text>
                          <Text style={{ color: d.a === null ? T.faint : T.text, fontFamily: T.mono, fontSize: 12, marginTop: 3 }}>
                            {d.a ?? '— absent'}
                          </Text>
                        </View>
                        <View style={{ flex: 1, backgroundColor: T.raised, borderColor: T.line, borderWidth: 1, borderRadius: radii.input, padding: 9 }}>
                          <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 9.5 }}>{comparison.b.toUpperCase()}</Text>
                          <Text style={{ color: d.b === null ? T.faint : T.text, fontFamily: T.mono, fontSize: 12, marginTop: 3 }}>
                            {d.b ?? '— absent'}
                          </Text>
                        </View>
                      </View>

                      <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>{d.detail}</Text>
                    </View>
                  </Panel>
                );
              })}
            </>
          )}
        </ScrollView>
      )}

      {tab === 'time' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}>
          <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
            Read from Postgres, not from this screen's memory — it survives a reload and a daemon
            restart. {current !== undefined ? `Scope: ${current.name}.` : ''}
          </Text>
          {events === null || events.length === 0 ? (
            <Empty text="Nothing recorded for this project yet. Scan a repo or provision something." />
          ) : events.map((e) => (
            <Panel key={e.id}>
              <View style={{ padding: spacing.md, gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                  <Text style={{ color: T.text, fontSize: 12.5, fontWeight: '700' }}>{label(e.kind)}</Text>
                  <Text style={{ color: T.faint, fontSize: 11 }}>{ago(e.ts)}</Text>
                </View>
                <Text style={{ color: T.dim, fontSize: 11.5, lineHeight: 17 }}>{summarise(e.kind, e.payload)}</Text>
              </View>
            </Panel>
          ))}
        </ScrollView>
      )}

      </View>

      {chatOpen && (
        <View style={{ width: 400 }}>
          <ChatPanel
            projectId={projectId}
            dir={dir.trim()}
            canPropose={missing.length > 0}
            onPlan={(p, from) => { setPlan(p); setNotice({ label: 'DRAFTED', text: `${from} drafted this. Nothing is created until you confirm it.` }); }}
          />
        </View>
      )}
      </View>
    </View>
  );
}

/* --------------------------------------------------------------- labels */

const KIND_LABEL: Record<string, string> = {
  session_opened: 'connected', session_closed: 'disconnected', repo_scanned: 'scanned repo',
  project_created: 'created project', provision_started: 'provision started',
  provision_succeeded: 'provisioned', provision_failed: 'provision failed',
  provision_blocked: 'blocked — another provision held the lock',
  yaml_exported: 'exported zerops.yaml', graph_read: 'read architecture',
};
const label = (k: string): string => KIND_LABEL[k] ?? k;

/** One line a human can read. Never raw JSON on screen. */
function summarise(kind: string, p: Record<string, unknown>): string {
  const s = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const n = (k: string): number | null => (typeof p[k] === 'number' ? (p[k] as number) : null);
  switch (kind) {
    case 'repo_scanned': {
      const missing = Array.isArray(p['missing']) ? (p['missing'] as string[]) : [];
      const scanned = Array.isArray(p['scanned']) ? (p['scanned'] as string[]) : [];
      // "Nothing missing" and "nothing to read" are opposite findings.
      if (scanned.length === 0) return `${s('dir')} — no recognised manifests, so nothing to compare`;
      return missing.length === 0
        ? `${s('dir')} — everything the repo needs is deployed`
        : `${missing.length} missing (${missing.join(', ')}) in ${s('dir')}`;
    }
    case 'provision_succeeded': {
      const c = Array.isArray(p['created']) ? (p['created'] as Array<{ hostname: string }>) : [];
      return `created ${c.map((x) => x.hostname).join(', ') || '(nothing)'}`;
    }
    case 'provision_failed': return `Zerops refused: ${s('error')}`;
    case 'provision_blocked': {
      const who = s('heldBy');
      return `${who === '' ? 'another session' : `${who.slice(0, 11)}…`} was already provisioning this project — refused rather than colliding`;
    }
    case 'provision_started': return 'took the single-writer lock on this project';
    case 'session_opened': return `${s('email')} — ${n('projects') ?? 0} project(s)`;
    case 'project_created': return `${s('name')} — empty, ready to fill`;
    case 'yaml_exported': return `${n('services') ?? 0} service(s) written to zerops.yaml`;
    default: return Object.keys(p).slice(0, 4).join(', ') || '—';
  }
}
