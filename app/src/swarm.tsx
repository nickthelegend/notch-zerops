/**
 * The two screens that show Notch doing things rather than reading them.
 *
 * ACTIONS is the evidential one. Every REST call, in order, with its status and its timing.
 * An app that draws infrastructure diagrams is indistinguishable from an app that draws
 * pictures until you can see the requests, so this exists to be looked at.
 *
 * AUTOPILOT is the argument. Three agents get the same measurements and are each told to
 * argue one side — capacity, cost, reliability — and the screen shows all three opinions, the
 * vote, and what it resolved to. The disagreement is the point: a single number labelled
 * "recommended: 2 containers" is a black box, and three named arguments is a decision you can
 * check.
 */
import { useState } from 'react';
import { ActivityIndicator, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { T, radii, spacing } from './theme';
import { Badge, Btn, Callout, Empty, MetricCard, Panel, SectionLabel, field } from './components';
import { api, type Action, type ArchNode, type Cycle, type Design } from './api';

/* ------------------------------------------------------------- actions */

const verbTint = (a: Action): string => (!a.ok ? T.err : a.write ? T.warn : T.dim);

export function ActionsPanel({
  actions, counts, onRefresh, busy,
}: {
  actions: readonly Action[];
  counts: { total: number; writes: number; failed: number; ms: number };
  onRefresh: () => void;
  busy: boolean;
}) {
  const [writesOnly, setWritesOnly] = useState(false);
  const shown = writesOnly ? actions.filter((a) => a.write) : actions;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <MetricCard label="API CALLS" value={String(counts.total)} />
        <MetricCard label="THAT CHANGED THINGS" value={String(counts.writes)} accent={counts.writes > 0} />
        <MetricCard label="FAILED" value={String(counts.failed)} />
        <MetricCard label="TOTAL TIME" value={`${(counts.ms / 1000).toFixed(1)}s`} />
      </View>

      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
        Every request Notch has made to Zerops this session, newest last. Writes are the ones
        that changed something on your account; a <Text style={{ fontFamily: T.mono }}>POST …/search</Text>{' '}
        is Zerops’ way of reading, not a change.
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Btn small label={busy ? '…' : 'Refresh'} onPress={onRefresh} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Switch value={writesOnly} onValueChange={setWritesOnly} />
          <Text style={{ color: T.dim, fontSize: 12 }}>Only what changed something</Text>
        </View>
      </View>

      {shown.length === 0 ? (
        <Empty text={writesOnly
          ? 'Nothing has changed your account yet. Provision or scale something and it appears here.'
          : 'No calls yet. Anything Notch asks Zerops shows up here as it happens.'} />
      ) : shown.map((a) => (
        <View
          key={a.seq}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            backgroundColor: T.panel, borderColor: a.write ? T.line2 : T.line, borderWidth: 1,
            borderLeftColor: verbTint(a), borderLeftWidth: 3,
            borderRadius: radii.input, paddingHorizontal: 11, paddingVertical: 8,
          }}
        >
          <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10, width: 34 }}>#{a.seq}</Text>
          <Text style={{ color: verbTint(a), fontFamily: T.mono, fontSize: 10, width: 46 }}>{a.method}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: T.text, fontSize: 12.5 }}>{a.summary}</Text>
            <Text numberOfLines={1} style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>{a.path}</Text>
            {a.error !== null && (
              <Text style={{ color: T.err, fontSize: 11, marginTop: 2 }}>{a.error}</Text>
            )}
          </View>
          {a.write && <Badge text="WRITE" tint={T.warn} />}
          <Text style={{ color: a.ok ? T.dim : T.err, fontFamily: T.mono, fontSize: 10, width: 30, textAlign: 'right' }}>
            {a.status === 0 ? '—' : a.status}
          </Text>
          <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10, width: 52, textAlign: 'right' }}>
            {a.ms}ms
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

/* ------------------------------------------------------------ autopilot */

const LENS_TINT: Record<string, string> = {
  capacity: '#67e8f9', cost: '#f59e0b', reliability: '#22c55e',
};
const VERB_LABEL: Record<string, string> = {
  scale_out: 'run one more', scale_in: 'run one fewer',
  raise_ceiling: 'allow one more', hold: 'change nothing',
};

export function AutopilotPanel({
  services, serviceId, onService, cycle, onRun, busy, armed, onArmed, ceiling, onCeiling,
}: {
  services: readonly ArchNode[];
  serviceId: string;
  onService: (id: string) => void;
  cycle: Cycle | null;
  onRun: () => void;
  busy: boolean;
  armed: boolean;
  onArmed: (v: boolean) => void;
  ceiling: number;
  onCeiling: (n: number) => void;
}) {
  const s = cycle?.signals;
  const d = cycle?.decision;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
        Notch puts real traffic through the service, measures what happens, and asks three
        agents what to do about it — one arguing for capacity, one for cost, one for
        reliability. Two of the three have to agree before anything moves.
      </Text>

      {/* who to watch */}
      <View style={{ gap: 8 }}>
        <SectionLabel text="SERVICE" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {services.length === 0
            ? <Text style={{ color: T.faint, fontSize: 12 }}>No services in this project yet.</Text>
            : services.map((n) => {
              const on = n.id === serviceId;
              return (
                <Text
                  key={n.id}
                  onPress={() => onService(n.id)}
                  style={{
                    color: on ? T.onBright : T.dim, backgroundColor: on ? T.bright : T.raised,
                    borderColor: on ? T.bright : T.line, borderWidth: 1, borderRadius: radii.pill,
                    paddingHorizontal: 11, paddingVertical: 5, fontSize: 12,
                    fontWeight: on ? '700' : '500', overflow: 'hidden',
                  }}
                >
                  {n.name}
                </Text>
              );
            })}
        </ScrollView>
      </View>

      {/* the safety catch */}
      <Panel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Switch value={armed} onValueChange={onArmed} />
          <Text style={{ color: armed ? T.warn : T.dim, fontSize: 13, fontWeight: '700' }}>
            {armed ? 'Armed — decisions will be applied' : 'Disarmed — decisions are shown, not applied'}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: T.dim, fontSize: 12 }}>Never more than</Text>
          <TextInput
            style={[field, { width: 54, paddingVertical: 6, textAlign: 'center', fontFamily: T.mono }]}
            value={String(ceiling)}
            onChangeText={(t) => onCeiling(Math.min(Math.max(Number(t.replace(/\D/g, '')) || 1, 1), 5))}
            keyboardType="number-pad"
          />
          <Text style={{ color: T.dim, fontSize: 12 }}>containers</Text>
        </View>
        <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17, marginTop: 8 }}>
          Containers cost money, so this starts disarmed and does every step except the last
          one. The ceiling is enforced by Notch after the vote, not requested from the agents —
          they can argue for twelve and still get {ceiling}.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn
            primary
            label={busy ? 'watching…' : armed ? 'Run a cycle and apply' : 'Run a cycle'}
            onPress={onRun}
          />
        </View>
      </Panel>

      {busy && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <ActivityIndicator size="small" color={T.primary} />
          <Text style={{ color: T.dim, fontSize: 12.5 }}>
            Putting traffic through the service, then convening the panel. Agents take a while.
          </Text>
        </View>
      )}

      {cycle === null ? (
        <Empty text="Run a cycle to see what the agents make of this service." />
      ) : (
        <>
          {/* what was measured */}
          <SectionLabel text="WHAT NOTCH MEASURED" />
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            <MetricCard label="CONTAINERS UP" value={`${s?.containers.active ?? 0}`} />
            <MetricCard label="ALLOWED" value={`${s?.policy.minContainers ?? '?'}–${s?.policy.maxContainers ?? '?'}`} />
            <MetricCard label="MEDIAN" value={s?.load.p50 === null || s?.load.p50 === undefined ? '—' : `${Math.round(s.load.p50)}ms`} />
            <MetricCard
              label="95TH PCTL"
              value={s?.load.p95 === null || s?.load.p95 === undefined ? '—' : `${Math.round(s.load.p95)}ms`}
              accent={(s?.load.p95 ?? 0) > 1000}
            />
            <MetricCard
              label="FAILED"
              value={s?.load.errorRate === null || s?.load.errorRate === undefined ? '—' : `${Math.round(s.load.errorRate * 100)}%`}
              accent={(s?.load.errorRate ?? 0) > 0}
            />
            <MetricCard label="REQUESTS" value={String(s?.load.samples ?? 0)} />
          </View>
          {s?.notes.map((n) => <Callout key={n} label="NOTE" text={n} tint={T.warn} />)}

          {/* the argument */}
          <SectionLabel text="WHAT THE PANEL SAID" />
          {d?.proposals.length === 0 ? (
            <Callout label="NO PANEL" tint={T.err} text="No agent produced a usable answer, so nothing was decided." />
          ) : d?.proposals.map((p) => (
            <Panel key={`${p.lens}:${p.agent}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: LENS_TINT[p.lens] ?? T.dim }} />
                <Text style={{ color: LENS_TINT[p.lens] ?? T.dim, fontFamily: T.mono, fontSize: 10, letterSpacing: 0.6 }}>
                  {p.lens.toUpperCase()}
                </Text>
                <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>{p.agent}</Text>
                <View style={{ flex: 1 }} />
                <Badge text={VERB_LABEL[p.verb] ?? p.verb} tint={p.verb === 'hold' ? T.dim : T.primary} />
                <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>{(p.ms / 1000).toFixed(1)}s</Text>
              </View>
              <Text style={{ color: T.text, fontSize: 13, lineHeight: 19, marginTop: 7 }}>{p.because}</Text>
            </Panel>
          ))}

          {cycle.discarded.map((x) => (
            <Callout
              key={`${x.lens}:${x.agent}`}
              label="DISCARDED"
              tint={T.warn}
              text={`${x.agent} on the ${x.lens} lens ${x.reason.replace(/\.$/, '')}. Its vote was not counted.`}
            />
          ))}

          {/* the outcome */}
          <SectionLabel text="WHAT WAS DECIDED" />
          <Panel tint={cycle.applied !== null ? T.ok : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <Text style={{ color: T.text, fontSize: 15, fontWeight: '800' }}>
                {VERB_LABEL[d?.verb ?? 'hold'] ?? d?.verb}
              </Text>
              <Badge text={`${d?.votes ?? 0} OF ${d?.of ?? 0}`} tint={T.primary} />
              {cycle.applied === null
                ? <Badge text={d?.target === null ? 'NOTHING TO DO' : 'NOT APPLIED — DISARMED'} tint={T.dim} />
                : <Badge text={cycle.applied.verified ? 'APPLIED AND CONFIRMED' : 'ACCEPTED, NOT YET LANDED'} tint={cycle.applied.verified ? T.ok : T.warn} />}
            </View>
            <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19, marginTop: 8 }}>{d?.rationale}</Text>
            {d?.clampNote !== null && d?.clampNote !== undefined && (
              <Text style={{ color: T.warn, fontSize: 12, lineHeight: 18, marginTop: 8 }}>
                Held to your limits — {d.clampNote}.
              </Text>
            )}
            {cycle.applied !== null && (
              <View style={{ marginTop: 10, gap: 4 }}>
                <Text style={{ color: T.ok, fontSize: 12.5 }}>{cycle.applied.note}</Text>
                <Text selectable style={{ color: T.faint, fontFamily: T.mono, fontSize: 10.5 }}>
                  {cycle.applied.from.minContainers ?? '?'}–{cycle.applied.from.maxContainers ?? '?'}
                  {'  →  '}
                  {cycle.applied.to.minContainers}–{cycle.applied.to.maxContainers}
                  {cycle.applied.processId === null ? '' : `   zerops process ${cycle.applied.processId}`}
                </Text>
              </View>
            )}
            {cycle.applied === null && d?.target !== null && d?.target !== undefined && (
              <Text style={{ color: T.warn, fontSize: 12.5, lineHeight: 18, marginTop: 8 }}>
                Armed, this would have set the range to {d.target.minContainers}–{d.target.maxContainers} containers.
              </Text>
            )}
          </Panel>
        </>
      )}
    </ScrollView>
  );
}

/* ------------------------------------------------------------ architect */

export function ArchitectPanel({
  agents, agent, onAgent, description, onDescription, design, onRun, busy, onAdopt,
}: {
  agents: ReadonlyArray<{ id: string; label: string }>;
  agent: string;
  onAgent: (id: string) => void;
  description: string;
  onDescription: (t: string) => void;
  design: Design | null;
  onRun: () => void;
  busy: boolean;
  onAdopt: (types: string[]) => void;
}) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
        Describe what you are building in your own words. An agent picks the services from what
        this account can actually create — and has to say why it chose each one, and why it
        turned down the alternatives it considered.
      </Text>

      <TextInput
        style={[field, { minHeight: 74, fontSize: 13, paddingVertical: 10 }]}
        value={description}
        onChangeText={onDescription}
        placeholder="I'm building a chat app with search and analytics…"
        placeholderTextColor={T.faint}
        multiline
      />

      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {agents.map((a) => {
          const on = a.id === agent;
          return (
            <Text
              key={a.id}
              onPress={() => onAgent(a.id)}
              style={{
                color: on ? T.onBright : T.dim, backgroundColor: on ? T.bright : T.raised,
                borderColor: on ? T.bright : T.line, borderWidth: 1, borderRadius: radii.pill,
                paddingHorizontal: 11, paddingVertical: 5, fontSize: 12,
                fontWeight: on ? '700' : '500', overflow: 'hidden',
              }}
            >
              {a.label}
            </Text>
          );
        })}
        <View style={{ flex: 1 }} />
        <Btn primary label={busy ? 'thinking…' : 'Design it'} onPress={onRun} />
      </View>

      {design === null ? (
        <Empty text="Nothing designed yet." />
      ) : (
        <>
          {design.understanding !== '' && (
            <Callout label="WHAT IT THINKS YOU MEANT" tint={T.primary} text={design.understanding} />
          )}

          <SectionLabel text="CHOSE" />
          {design.chosen.length === 0
            ? <Callout label="NOTHING" tint={T.warn} text={`${design.agent} did not name a service this account can create.`} />
            : design.chosen.map((c) => (
              <Panel key={c.type}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <Text style={{ color: T.text, fontSize: 14, fontWeight: '700' }}>{c.type}</Text>
                  <Badge text={c.role} tint={T.thread} />
                </View>
                <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19, marginTop: 6 }}>{c.because}</Text>
              </Panel>
            ))}

          {design.rejected.length > 0 && (
            <>
              <SectionLabel text="CONSIDERED AND TURNED DOWN" />
              {design.rejected.map((r) => (
                <View
                  key={r.type}
                  style={{
                    backgroundColor: T.panel, borderColor: T.line, borderWidth: 1,
                    borderRadius: radii.input, paddingHorizontal: 12, paddingVertical: 9,
                  }}
                >
                  <Text style={{ color: T.dim, fontSize: 13, fontWeight: '600' }}>{r.type}</Text>
                  <Text style={{ color: T.faint, fontSize: 12, lineHeight: 18, marginTop: 3 }}>{r.because}</Text>
                </View>
              ))}
            </>
          )}

          {design.unavailable.length > 0 && (
            <Callout
              label="NOT ON ZEROPS"
              tint={T.warn}
              text={`${design.agent} also named ${design.unavailable.join(', ')}, which this account cannot create. Dropped rather than swapped for something similar.`}
            />
          )}

          {design.chosen.length > 0 && (
            <Btn
              primary
              label={`Put these ${design.chosen.length} on the board`}
              onPress={() => onAdopt(design.chosen.map((c) => c.type))}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}
