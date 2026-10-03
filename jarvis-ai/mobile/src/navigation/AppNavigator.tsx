import React, { useEffect } from 'react';
import { Linking } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useAssistant } from '../hooks/AssistantContext';
import { navRef } from './ref';
import HomeScreen from '../screens/HomeScreen';
import ChatScreen from '../screens/ChatScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import WeatherScreen from '../screens/WeatherScreen';
import AgricultureScreen from '../screens/AgricultureScreen';
import ShopScreen from '../screens/ShopScreen';
import SettingsScreen from '../screens/SettingsScreen';
import { CalendarScreen, CommandScreen, HistoryScreen, MemoryScreen, PhoneAppsScreen, RemindersScreen, SearchScreen } from '../screens/CommandScreens';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const { ready, settings, startVoice, colors } = useAssistant();

  // Launcher shortcut / automation entry: any "Open URL" -> jarvisai://listen
  useEffect(() => {
    const handle = (url: string | null) => { if (url?.startsWith('jarvisai://listen')) { navRef.isReady() && navRef.navigate('Home'); setTimeout(() => void startVoice(), 400); } };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, [startVoice]);

  if (!ready) return null;
  const base = settings.theme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <NavigationContainer ref={navRef} theme={{ ...base, colors: { ...base.colors, background: colors.bg, card: colors.bg, text: colors.text } }}>
      <StatusBar style={settings.theme === 'dark' ? 'light' : 'dark'} />
      <Stack.Navigator initialRouteName={settings.onboarded ? 'Home' : 'Onboarding'} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="History" component={HistoryScreen} />
        <Stack.Screen name="Command" component={CommandScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Weather" component={WeatherScreen} />
        <Stack.Screen name="Calendar" component={CalendarScreen} />
        <Stack.Screen name="Reminders" component={RemindersScreen} />
        <Stack.Screen name="PhoneApps" component={PhoneAppsScreen} />
        <Stack.Screen name="Agriculture" component={AgricultureScreen} />
        <Stack.Screen name="Shop" component={ShopScreen} />
        <Stack.Screen name="Memory" component={MemoryScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
