/**
 * Ask the agents you already run about the infrastructure in front of you.
 *
 * The agent picker is the load-bearing control, not decoration: switching mid-thread is the
 * Notch move — hand the same question to a different agent and compare, without leaving the
 * board you are asking about. Each answer is stamped with who said it and how long they took,
 * because "Claude said" and "Codex said" are different facts.
 *
 * Answers are prose in a narrow column. There is deliberately no markdown renderer: the reply
 * is shown as the agent wrote it, in monospace, so nothing is silently reformatted into
 * looking more authoritative than it is.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { T, radii, spacing } from './theme';
import { Btn, field } from './components';
import { api, type AgentInfo, type Plan } from './api';

interface Turn {
  id: number;
  who: 'you' | 'agent';
  agentId?: string;
  label?: string;
  text: string;
  ms?: number;
  failed?: boolean;
}

const SUGGESTIONS = [
  'Why does this repo need Qdrant?',
  'What breaks if I deploy without the queue?',
  'Which of these gaps matters first, and why?',
];

/**
 * A mark per agent, drawn rather than fetched.
 *
 * Each is the shape of that tool's own identity in its own colour — a burst for Claude, a
 * knot for Codex, a four-point spark for Gemini, brackets for OpenCode — not a traced
 * trademark, and not a downloaded asset. The app ships no network images and no icon font, so
 * an agent still reads as itself with the machine offline, which is the state Notch is usually
 * in when it is doing something interesting.
 */
const MARK: Readonly<Record<string, string>> = {
  claude: '#d97757', codex: '#74aa9c', gemini: '#8ab4f8', opencode: '#a78bfa',
};
const markTint = (id: string): string => MARK[id] ?? T.dim;

function AgentMark({ id, size = 16 }: { id: string; size?: number }) {
  const c = markTint(id);
  if (id === 'claude') {
    // Radiating strokes from a common centre.
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {[0, 45, 90, 135].map((deg) => {
          const r = (deg * Math.PI) / 180;
          const dx = Math.cos(r) * 8.5;
          const dy = Math.sin(r) * 8.5;
          return (
            <Path
              key={deg}
              d={`M ${12 - dx} ${12 - dy} L ${12 + dx} ${12 + dy}`}
              stroke={c} strokeWidth={2.4} strokeLinecap="round"
            />
          );
        })}
      </Svg>
    );
  }
  if (id === 'gemini') {
    // Four-point spark with concave sides.
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d="M12 1 C 13 8 16 11 23 12 C 16 13 13 16 12 23 C 11 16 8 13 1 12 C 8 11 11 8 12 1 Z"
          fill={c}
        />
      </Svg>
    );
  }
  if (id === 'codex') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={2.2} fill="none" />
        <Circle cx={12} cy={12} r={3.4} fill={c} />
      </Svg>
    );
  }
  if (id === 'opencode') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M9 4 L3.5 12 L9 20" stroke={c} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <Path d="M15 4 L20.5 12 L15 20" stroke={c} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={4} y={4} width={16} height={16} rx={4} stroke={c} strokeWidth={2.2} fill="none" />
    </Svg>
  );
}

export function ChatPanel({
  projectId, dir, canPropose, onPlan,
}: {
  projectId: string;
  dir: string;
  /** There is something missing that an agent could propose closing. */
  canPropose: boolean;
  /** Hands a drafted plan to the screen's own preview — the one a human confirms. */
  onPlan: (plan: Plan & { types: string[]; ha: boolean }, from: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agent, setAgent] = useState('');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const scroller = useRef<ScrollView | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    void api.agents()
      .then((r) => { setAgents(r.agents); setAgent((cur) => (cur === '' ? r.agents[0]?.id ?? '' : cur)); })
      .catch(() => setAgents([]));
  }, []);

  const send = async (question: string) => {
    const q = question.trim();
    if (q === '' || busy || agent === '' || projectId === '') return;
    setDraft('');
    setBusy(true);
    const mine: Turn = { id: nextId.current++, who: 'you', text: q };
    setTurns((t) => [...t, mine]);
    try {
      const r = await api.chat(agent, q, projectId, dir);
      setTurns((t) => [...t, { id: nextId.current++, who: 'agent', agentId: agent, label: r.agent, text: r.reply, ms: r.ms }]);
    } catch (e) {
      // A failed agent is shown as a turn, not swallowed: which agent failed and why is part
      // of the conversation, and it is usually the answer to "why is this empty".
      setTurns((t) => [...t, {
        id: nextId.current++, who: 'agent', agentId: agent,
        label: agents?.find((a) => a.id === agent)?.label ?? agent,
        text: (e as Error).message, failed: true,
      }]);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Ask the agent to draft the fix.
   *
   * What comes back is a list of service types, not a file. The daemon runs them through the
   * same planner the button uses and hands the result to the preview the human confirms — so
   * this button costs the agent an opinion and gains it no authority.
   */
  const propose = async () => {
    if (busy || agent === '' || projectId === '') return;
    setBusy(true);
    setTurns((t) => [...t, { id: nextId.current++, who: 'you', text: 'Draft a fix for what is missing.' }]);
    try {
      const r = await api.propose(agent, projectId, dir, false);
      const lines = r.plan === null
        ? [r.note ?? 'Nothing proposed.']
        : [
          `Proposed ${r.proposal.types.length}: ${r.proposal.types.join(', ')}`,
          ...r.proposal.types.map((t) => `  ${t} — ${r.proposal.why[t] ?? 'no reason given'}`),
          '',
          'Drafted into the preview above. Nothing is created until you confirm it.',
        ];
      if (r.proposal.rejected.length > 0) {
        lines.push('', `Discarded (not a Zerops service type): ${r.proposal.rejected.join(', ')}`);
      }
      setTurns((t) => [...t, {
        id: nextId.current++, who: 'agent', agentId: agent, label: r.agent, text: lines.join('\n'), ms: r.ms,
      }]);
      if (r.plan !== null) onPlan({ ...r.plan, types: r.proposal.types, ha: false }, r.agent);
    } catch (e) {
      setTurns((t) => [...t, {
        id: nextId.current++, who: 'agent', agentId: agent,
        label: agents?.find((a) => a.id === agent)?.label ?? agent,
        text: (e as Error).message, failed: true,
      }]);
    } finally {
      setBusy(false);
    }
  };

  const ready = projectId !== '';

  return (
    <View style={{ flex: 1, backgroundColor: T.panel, borderLeftColor: T.line, borderLeftWidth: 1 }}>
      {/* who is answering */}
      <View style={{ padding: spacing.md, borderBottomColor: T.line, borderBottomWidth: 1, gap: 8, zIndex: 30 }}>
        <Text style={{ color: T.dim, fontFamily: T.mono, fontSize: 10, letterSpacing: 0.8 }}>ASK AN AGENT</Text>
        {agents === null ? (
          <Text style={{ color: T.faint, fontSize: 12 }}>looking for agents on this machine…</Text>
        ) : agents.length === 0 ? (
          <Text style={{ color: T.warn, fontSize: 12, lineHeight: 17 }}>
            No agent CLIs found on PATH. Notch drives the ones you already have — install Claude
            Code, Codex, OpenCode or Gemini and reopen.
          </Text>
        ) : (
          <Pressable
            onPress={() => setPicking((v) => !v)}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 9,
              backgroundColor: T.raised, borderColor: picking ? T.line2 : T.line, borderWidth: 1,
              borderRadius: radii.input, paddingHorizontal: 11, paddingVertical: 9,
            }}
          >
            <AgentMark id={agent} size={17} />
            <Text style={{ color: T.text, fontSize: 13, fontWeight: '600', flex: 1 }}>
              {agents.find((a) => a.id === agent)?.label ?? 'Pick an agent'}
            </Text>
            <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>
              {agents.length} on PATH
            </Text>
            <Text style={{ color: T.dim, fontSize: 10 }}>{picking ? '▲' : '▼'}</Text>
          </Pressable>
        )}
      </View>

      {/*
        The menu is a SIBLING of the header, not a child of it.

        Every react-native-web View clips its overflow, so a menu absolutely positioned inside
        the header would be cut off at the header's own bottom border — visible as a one-line
        sliver. Hung off the panel root instead, where there is room for it.
      */}
      {picking && agents !== null && agents.length > 0 && (
        <>
          <Pressable
            onPress={() => setPicking(false)}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 40 }}
          />
          <View style={{
            position: 'absolute', top: 74, left: spacing.md, right: spacing.md, zIndex: 50,
            backgroundColor: T.raised, borderColor: T.line, borderWidth: 1, borderRadius: radii.card,
            paddingVertical: 5, overflow: 'hidden',
          }}>
            {agents.map((a) => {
              const on = a.id === agent;
              return (
                <Pressable
                  key={a.id}
                  onPress={() => { setAgent(a.id); setPicking(false); }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingHorizontal: 11, paddingVertical: 9,
                    backgroundColor: on ? T.panel : 'transparent',
                  }}
                >
                  <AgentMark id={a.id} size={17} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: T.text, fontSize: 13, fontWeight: on ? '700' : '500' }}>{a.label}</Text>
                    <Text numberOfLines={1} style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>{a.path}</Text>
                  </View>
                  {on && <Text style={{ color: markTint(a.id), fontSize: 12 }}>✓</Text>}
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {/* thread */}
      <ScrollView
        ref={(r) => { scroller.current = r; }}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md, gap: 12 }}
      >
        {turns.length === 0 && (
          <View style={{ gap: 10 }}>
            <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
              These agents run on your machine and are handed the live state of this project —
              its services, its gaps, and the file evidence behind each one. They read; they
              cannot provision.
            </Text>
            {ready && agents !== null && agents.length > 0 && SUGGESTIONS.map((s) => (
              <Text
                key={s}
                onPress={() => void send(s)}
                style={{
                  color: T.thread, fontSize: 12.5, lineHeight: 18,
                  backgroundColor: T.raised, borderColor: T.line, borderWidth: 1,
                  borderRadius: radii.input, paddingHorizontal: 11, paddingVertical: 9,
                  overflow: 'hidden',
                }}
              >
                {s}
              </Text>
            ))}
          </View>
        )}

        {turns.map((t) => t.who === 'you' ? (
          <View key={t.id} style={{ alignSelf: 'flex-end', maxWidth: '92%' }}>
            <View style={{ backgroundColor: T.raised, borderColor: T.line, borderWidth: 1, borderRadius: radii.card, paddingHorizontal: 12, paddingVertical: 9 }}>
              <Text style={{ color: T.text, fontSize: 13, lineHeight: 19 }}>{t.text}</Text>
            </View>
          </View>
        ) : (
          <View key={t.id} style={{ gap: 5 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              {/* Who said it, in their own colour: two agents disagreeing should look different. */}
              <AgentMark id={t.agentId ?? ''} size={13} />
              <Text style={{
                color: t.failed === true ? T.err : markTint(t.agentId ?? ''),
                fontFamily: T.mono, fontSize: 10, letterSpacing: 0.5,
              }}>
                {(t.label ?? '').toUpperCase()}
              </Text>
              {t.ms !== undefined && (
                <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>{(t.ms / 1000).toFixed(1)}s</Text>
              )}
            </View>
            <Text
              selectable
              style={{
                color: t.failed === true ? T.err : T.text,
                fontFamily: T.mono, fontSize: 11.5, lineHeight: 18,
              }}
            >
              {t.text}
            </Text>
          </View>
        ))}

        {busy && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color={T.primary} />
            <Text style={{ color: T.dim, fontSize: 12 }}>
              {agents?.find((a) => a.id === agent)?.label ?? 'the agent'} is reading your project…
            </Text>
          </View>
        )}
      </ScrollView>

      {/* ask */}
      <View style={{ padding: spacing.md, borderTopColor: T.line, borderTopWidth: 1, gap: 8 }}>
        <TextInput
          style={[field, { fontSize: 13, paddingVertical: 10, minHeight: 44 }]}
          value={draft}
          onChangeText={setDraft}
          placeholder={ready ? 'Ask about this project…' : 'Pick a project first'}
          placeholderTextColor={T.faint}
          editable={ready && !busy}
          multiline
          onSubmitEditing={() => void send(draft)}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn primary label={busy ? 'thinking…' : 'Ask'} onPress={() => void send(draft)} />
          </View>
          {canPropose && (
            <View style={{ flex: 1 }}>
              <Btn label="Draft a fix" onPress={() => void propose()} />
            </View>
          )}
        </View>
      </View>
    </View>
  );
}
