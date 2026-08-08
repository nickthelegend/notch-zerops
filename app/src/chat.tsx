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
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';

import { T, radii, spacing } from './theme';
import { Btn, field } from './components';
import { api, type AgentInfo } from './api';

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

export function ChatPanel({ projectId, dir }: { projectId: string; dir: string }) {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agent, setAgent] = useState('');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
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

  const ready = projectId !== '';

  return (
    <View style={{ flex: 1, backgroundColor: T.panel, borderLeftColor: T.line, borderLeftWidth: 1 }}>
      {/* who is answering */}
      <View style={{ padding: spacing.md, borderBottomColor: T.line, borderBottomWidth: 1, gap: 8 }}>
        <Text style={{ color: T.dim, fontFamily: T.mono, fontSize: 10, letterSpacing: 0.8 }}>ASK AN AGENT</Text>
        {agents === null ? (
          <Text style={{ color: T.faint, fontSize: 12 }}>looking for agents on this machine…</Text>
        ) : agents.length === 0 ? (
          <Text style={{ color: T.warn, fontSize: 12, lineHeight: 17 }}>
            No agent CLIs found on PATH. Notch drives the ones you already have — install Claude
            Code, Codex, OpenCode or Gemini and reopen.
          </Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {agents.map((a) => {
              const on = a.id === agent;
              return (
                <Text
                  key={a.id}
                  onPress={() => setAgent(a.id)}
                  style={{
                    color: on ? T.onBright : T.dim,
                    backgroundColor: on ? T.bright : T.raised,
                    borderColor: on ? T.bright : T.line, borderWidth: 1,
                    borderRadius: radii.pill, paddingHorizontal: 11, paddingVertical: 5,
                    fontSize: 12, fontWeight: on ? '700' : '500', overflow: 'hidden',
                  }}
                >
                  {a.label}
                </Text>
              );
            })}
          </ScrollView>
        )}
      </View>

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
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.failed === true ? T.err : T.primary }} />
              <Text style={{ color: t.failed === true ? T.err : T.primary, fontFamily: T.mono, fontSize: 10, letterSpacing: 0.5 }}>
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
        <Btn
          primary
          label={busy ? 'thinking…' : 'Ask'}
          onPress={() => void send(draft)}
        />
      </View>
    </View>
  );
}
