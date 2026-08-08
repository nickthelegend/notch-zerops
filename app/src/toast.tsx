/**
 * Transient messages, over the app rather than inside it.
 *
 * These used to be `Callout` banners rendered in the main column, and every one of them pushed
 * the canvas down. Three actions in a row — an error, an export, a service added — and the
 * board you were working on was off the bottom of the window, with three notices about things
 * you had already done stacked above it. The information was right; the placement made the app
 * shorter every time you used it.
 *
 * So: overlaid, stacked from the bottom, and self-dismissing. Errors stay put until dismissed,
 * because "could not reach the daemon" scrolling away after four seconds is how a person ends
 * up staring at a stale screen wondering why nothing works.
 *
 * Nothing is LOST by fading, either — every toast is also an entry in the action log, which is
 * the durable place to go and look at what happened.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { T, radii } from './theme';

export type ToastKind = 'ok' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  label: string;
  text: string;
}

const TINT: Record<ToastKind, string> = { ok: T.ok, error: T.err, info: T.primary };

/** Errors persist. Everything else gets five seconds, which is long enough to read two lines. */
const LIFETIME: Record<ToastKind, number | null> = { ok: 5000, info: 5000, error: null };

let nextId = 1;

/**
 * The queue, as a hook.
 *
 * Held here rather than in a context because there is exactly one consumer — the project
 * screen — and a provider tree for one consumer is ceremony.
 */
export function useToasts(): {
  toasts: Toast[];
  push: (kind: ToastKind, label: string, text: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
  }, []);

  const dismiss = (id: number): void => {
    const t = timers.current.get(id);
    if (t !== undefined) { clearTimeout(t); timers.current.delete(id); }
    setToasts((cur) => cur.filter((x) => x.id !== id));
  };

  const push = (kind: ToastKind, label: string, text: string): void => {
    const id = nextId++;
    // Bounded: a polling loop that fails every second must not build an infinite stack.
    setToasts((cur) => [...cur, { id, kind, label, text }].slice(-4));
    const life = LIFETIME[kind];
    if (life !== null) {
      timers.current.set(id, setTimeout(() => dismiss(id), life));
    }
  };

  return { toasts, push, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <View
      /*
       * `pointerEvents="box-none"` and not `none`: the toasts themselves must stay clickable so
       * an error can be dismissed, while every pixel around them passes straight through to the
       * canvas underneath. With `none` the dismiss does nothing; without either, an invisible
       * full-screen View eats every click on the board.
       */
      pointerEvents="box-none"
      style={{ position: 'absolute', right: 16, bottom: 16, gap: 8, maxWidth: 420, zIndex: 100 }}
    >
      {toasts.map((t) => (
        <Pressable
          key={t.id}
          onPress={() => onDismiss(t.id)}
          style={{
            backgroundColor: T.panel,
            borderColor: TINT[t.kind], borderWidth: 1, borderLeftWidth: 3,
            borderRadius: radii.card, paddingHorizontal: 13, paddingVertical: 10,
            shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: TINT[t.kind], fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.8 }}>
              {t.label.toUpperCase()}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 9 }}>
              {t.kind === 'error' ? 'CLICK TO DISMISS' : ''}
            </Text>
          </View>
          <Text style={{ color: T.text, fontSize: 12.5, lineHeight: 18, marginTop: 4 }}>{t.text}</Text>
        </Pressable>
      ))}
    </View>
  );
}
