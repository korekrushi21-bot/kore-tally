import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AssistantProvider } from './src/hooks/AssistantContext';
import AppNavigator from './src/navigation/AppNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <AssistantProvider>
        <AppNavigator />
      </AssistantProvider>
    </SafeAreaProvider>
  );
}
