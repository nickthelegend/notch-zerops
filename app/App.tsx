/**
 * Notch — the Zerops screens. Same Expo app, same design system as Notch itself.
 *
 * Two routes and no third: hand the daemon a token, or work on a project. The session lives in
 * the daemon's memory, not here, so this asks on boot whether one is already open — that is why
 * a reload does not make you paste the token again, and why closing the daemon does.
 */
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaView, View } from 'react-native';

import { api, type Session } from './src/api';
import { electronPlatform, installDragRegion } from './src/native';
import { ProjectScreen, TokenScreen } from './src/screens';
import { T } from './src/theme';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booted, setBooted] = useState(false);
  const platform = electronPlatform();

  useEffect(() => { installDragRegion(); }, []);

  useEffect(() => {
    void api.status()
      .then((s) => {
        if (s.connected && s.email !== undefined) {
          setSession({ email: s.email, projectCount: s.projectCount ?? 0, tokenHint: s.tokenHint ?? '' });
        }
      })
      // Not connected yet is the normal first state, not an error worth showing.
      .catch(() => {})
      .finally(() => setBooted(true));
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar style="light" backgroundColor={T.bg} />
      {/*
        The window's drag strip. `titleBarStyle: hiddenInset` removes the frame but leaves the
        macOS traffic lights floating at (16,14), so the app owes them clearance and the window
        owes the user somewhere to grab it. 38px of nothing, present only inside the shell.
      */}
      {platform !== null && (
        <View
          // @ts-expect-error -- dataSet is react-native-web's way through to a DOM attribute.
          dataSet={{ notchDrag: true }}
          style={{ height: 38, backgroundColor: T.panel, borderBottomColor: T.line, borderBottomWidth: 1 }}
        />
      )}
      {!booted ? (
        <View style={{ flex: 1, backgroundColor: T.bg }} />
      ) : session === null ? (
        <TokenScreen onConnected={setSession} />
      ) : (
        <ProjectScreen session={session} onDisconnect={() => setSession(null)} />
      )}
    </SafeAreaView>
  );
}
