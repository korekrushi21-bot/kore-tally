import React, { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Btn, Input, Screen, T } from '../components/ui';
import { MessageBubble } from '../components/MessageBubble';
import { useAssistant } from '../hooks/AssistantContext';

export default function ChatScreen({ navigation }: any) {
  const { messages, send, state, cancel, stopSpeak, newConversation, startVoice, colors } = useAssistant();
  const [text, setText] = useState('');
  const list = useRef<FlatList>(null);
  useEffect(() => { setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50); }, [messages.length]);
  const busy = state === 'thinking' || state === 'processing';

  return (
    <Screen
      scroll={false}
      title="Chat"
      onBack={() => navigation.goBack()}
      right={<Pressable onPress={newConversation}><T style={{ color: colors.accent }}>New</T></Pressable>}
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item, index }) => <MessageBubble m={item} isLast={index === messages.length - 1} />}
          ListEmptyComponent={<T sub style={{ textAlign: 'center', marginTop: 40 }}>Ask anything — in मराठी, हिंदी or English.</T>}
        />
        {busy && <View style={{ paddingHorizontal: 16 }}><T sub size={13}>Thinking…</T></View>}
        <View style={{ flexDirection: 'row', gap: 8, padding: 12, alignItems: 'center' }}>
          <Pressable onPress={() => { void startVoice(); navigation.navigate('Home'); }}><Text style={{ fontSize: 26 }}>🎙</Text></Pressable>
          <Input value={text} onChangeText={setText} placeholder="Message" style={{ flex: 1 }} onSubmitEditing={() => { void send(text); setText(''); }} returnKeyType="send" />
          {busy ? <Btn label="Stop" kind="danger" onPress={cancel} />
            : state === 'speaking' ? <Btn label="Mute" kind="ghost" onPress={stopSpeak} />
            : <Btn label="Send" onPress={() => { void send(text); setText(''); }} disabled={!text.trim()} />}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
